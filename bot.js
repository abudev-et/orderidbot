import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import TelegramBot from "node-telegram-bot-api";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const STAMP_LABELS = String(process.env.STAMP_LABELS || "false").toLowerCase() === "true";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const ROOT = path.resolve("./data");
fs.mkdirSync(ROOT, { recursive: true });

/**
 * In-memory state per chat:
 * {
 *   lastImagePath?: string,
 *   fronts?: Array<{path: string, seq: number}>,
 *   backs?: Array<{path: string, seq: number}>,
 *   pairs?: Array<{front: string, back: string}>,
 *   sequence?: number,
 *   currentGroup?: number,
 *   imageGroups?: Array<Array<{path: string, type: string, seq: number}>>
 * }
 */
const state = new Map();
function getState(chatId) {
  if (!state.has(chatId)) state.set(chatId, { pairs: [], fronts: [], backs: [], sequence: 0, currentGroup: 0, imageGroups: [[]] });
  return state.get(chatId);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      resolve({ stdout, stderr });
    });
  });
}

async function downloadTelegramFile(fileId, outPath, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const link = await bot.getFileLink(fileId);
      const res = await fetch(link);
      if (!res.ok) throw new Error("Failed to download file from Telegram");
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(outPath, buf);
      return outPath;
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries - 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`Download failed after ${maxRetries} attempts: ${lastError.message}`);
}


async function stampLabel(inputImgPath, labelText, outPath) {
  const img = sharp(inputImgPath);
  const meta = await img.metadata();
  const w = meta.width ?? 1200;
  const h = meta.height ?? 800;

  const fontSize = Math.max(32, Math.floor(Math.min(w, h) * 0.05));
  const pad = Math.max(12, Math.floor(fontSize * 0.35));
  const boxW = Math.floor(fontSize * (labelText.length * 0.75) + pad * 2);
  const boxH = Math.floor(fontSize * 1.3);

  const x = w - boxW - pad;
  const y = pad;

  const svg = `
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${x}" y="${y}" rx="10" ry="10"
        width="${boxW}" height="${boxH}" fill="rgba(0,0,0,0.55)" />
      <text x="${x + pad}" y="${y + Math.floor(boxH * 0.75)}"
        font-family="Arial" font-size="${fontSize}" font-weight="700"
        fill="white">${labelText}</text>
    </svg>
  `.trim();

  await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPath);
  return outPath;
}

// Layout with exact measurements from PUB template
// Page: 8.268" × 11.693" (595.30 × 841.90 points)
// Image size: 3.32" × 1.99" (239.04 × 143.28 points)
// Front: at horizontal=0.669", vertical=0.296"
// Back: at horizontal=4.22", vertical=0.302"
// Conversion: 1 inch = 72 points
const LAYOUT = {
  pageWpt: 595.30,
  pageHpt: 841.90,
  frontBox: { x: 48.17, y: 21.31, w: 239.04, h: 143.28 },
  backBox: { x: 303.84, y: 21.74, w: 239.04, h: 143.28 }
};

/* ==================================
   2) Generate PDF (same as PUB page)
   ================================== */

async function makeSinglePagePdf(frontImg, backImg, outPdf) {
  const doc = new PDFDocument({ autoFirstPage: false });

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outPdf);
    doc.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);

    try {
      doc.addPage({ size: [LAYOUT.pageWpt, LAYOUT.pageHpt], margin: 0 });

      // FRONT in measured frontBox
      doc.image(frontImg, LAYOUT.frontBox.x, LAYOUT.frontBox.y, {
        fit: [LAYOUT.frontBox.w, LAYOUT.frontBox.h],
        align: "center",
        valign: "center"
      });

      // BACK in measured backBox
      doc.image(backImg, LAYOUT.backBox.x, LAYOUT.backBox.y, {
        fit: [LAYOUT.backBox.w, LAYOUT.backBox.h],
        align: "center",
        valign: "center"
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });

  return outPdf;
}

async function makeMultiIdPdf(pairs, outPdf) {
  const doc = new PDFDocument({ autoFirstPage: false });
  const count = Math.min(pairs.length, 5);

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outPdf);
    doc.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);

    try {
      doc.addPage({ size: [LAYOUT.pageWpt, LAYOUT.pageHpt], margin: 0 });

      // All IDs use single column layout (vertical stack)
      const cols = 1;

      // Horizontal positions: front x=0.66", back x=4.23"
      // Conversion: 1 inch = 72 points
      const firstFrontX = 47.52;  // 0.66"
      const firstBackX = 304.56;   // 4.23"
      
      // Vertical positions for each row (exact measurements from PUB)
      // ID1: 0.3", ID2: 2.47", ID3: 4.77", ID4: 7.13", ID5: 9.43"
      const verticalPositions = [
        21.6,   // 0.3"
        177.84, // 2.47"
        343.44, // 4.77"
        513.36, // 7.13"
        678.96  // 9.43"
      ];
      const horizontalSpacing = LAYOUT.pageWpt / cols;

      for (let i = 0; i < count; i++) {
        // For vertical ordering (column-major): fill columns top-to-bottom
        // Calculate rows per column
        const rowsPerCol = Math.ceil(count / cols);
        const col = Math.floor(i / rowsPerCol);
        const row = i % rowsPerCol;
        
        // Use absolute positions with column offset
        const frontX = firstFrontX + (col * horizontalSpacing);
        const backX = firstBackX + (col * horizontalSpacing);
        const yPos = verticalPositions[row] || verticalPositions[verticalPositions.length - 1];

        // FRONT
        doc.image(pairs[i].front, frontX, yPos, {
          fit: [LAYOUT.frontBox.w, LAYOUT.frontBox.h],
          align: "center",
          valign: "center"
        });

        // BACK
        doc.image(pairs[i].back, backX, yPos, {
          fit: [LAYOUT.backBox.w, LAYOUT.backBox.h],
          align: "center",
          valign: "center"
        });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });

  return outPdf;
}

/* ======================
   3) Telegram bot logic
   ====================== */

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  state.set(chatId, { pairs: [], fronts: [], backs: [], sequence: 0, currentGroup: 0, imageGroups: [[]] });
  await bot.sendMessage(
    chatId,
    [
      "✅ Send up to 10 images (5 IDs) with separators!",
      "",
      "📸 How to send images:",
      "",
      "Method 1 (Recommended): With Caption",
      "• Send 2 images with captions 'Front' and 'Back'",
      "• Send ANY TEXT to separate IDs (e.g., 'next', '2', 'ID2')",
      "• Send next 2 images for next ID",
      "• Example: Front, Back, 'next', Front, Back, 'next', ...",
      "",
      "Method 2: Manual tagging",
      "1) Send 2 images",
      "2) Type: front, back (or /front /back)",
      "3) Send ANY TEXT to separate (e.g., 'next')",
      "4) Repeat for more IDs",
      "",
      "When done:",
      "📄 /pdf - generates PDF with all IDs",
      "",
      "Commands:",
      "/status - check current progress",
      "/reset - clear all and start over",
      "/next - manually start next ID group",
      "",
      "✅ Supports up to 5 IDs (10 images)!"
    ].join("\n")
  );
});

bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  state.set(chatId, { pairs: [], fronts: [], backs: [], sequence: 0, currentGroup: 0, imageGroups: [[]] });
  await bot.sendMessage(chatId, "✅ Reset done.");
});

bot.onText(/\/next/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);
  st.currentGroup = (st.currentGroup || 0) + 1;
  if (!st.imageGroups[st.currentGroup]) {
    st.imageGroups[st.currentGroup] = [];
  }
  await bot.sendMessage(chatId, `✅ Group #${st.currentGroup + 1} started.`);
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);
  
  const groups = st.imageGroups || [[]];
  const currentGroupNum = (st.currentGroup || 0) + 1;
  const totalGroups = groups.filter(g => g.length > 0).length;
  
  let statusMsg = `📊 Current Status:\n\n`;
  statusMsg += `� ID Groups: ${totalGroups}\n`;
  statusMsg += `🔄 Current group: #${currentGroupNum}\n\n`;
  
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].length > 0) {
      const fronts = groups[i].filter(img => img.type === 'front').length;
      const backs = groups[i].filter(img => img.type === 'back').length;
      statusMsg += `ID #${i + 1}: ${fronts} front(s), ${backs} back(s)\n`;
    }
  }
  
  statusMsg += `\n💡 Send text to start next ID, or /pdf to generate`;
  
  await bot.sendMessage(chatId, statusMsg);
});

bot.onText(/\/front/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);
  if (!st.lastImagePath) return bot.sendMessage(chatId, "Send an image first, then /front.");
  
  if (!st.fronts) st.fronts = [];
  if (st.fronts.length >= 5) {
    return bot.sendMessage(chatId, "⚠️ Maximum 5 FRONT images reached.");
  }
  
  st.sequence = (st.sequence || 0) + 1;
  st.fronts.push({ path: st.lastImagePath, seq: st.sequence });
  
  const groupIdx = st.currentGroup || 0;
  if (!st.imageGroups) st.imageGroups = [[]];
  if (!st.imageGroups[groupIdx]) st.imageGroups[groupIdx] = [];
  st.imageGroups[groupIdx].push({ path: st.lastImagePath, type: 'front', seq: st.sequence });
  
  const frontCount = st.fronts.length;
  const backCount = st.backs?.length || 0;
  await bot.sendMessage(chatId, `✅ FRONT #${frontCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
});

bot.onText(/\/back/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);
  if (!st.lastImagePath) return bot.sendMessage(chatId, "Send an image first, then /back.");
  
  if (!st.backs) st.backs = [];
  if (st.backs.length >= 5) {
    return bot.sendMessage(chatId, "⚠️ Maximum 5 BACK images reached.");
  }
  
  st.sequence = (st.sequence || 0) + 1;
  st.backs.push({ path: st.lastImagePath, seq: st.sequence });
  
  const groupIdx = st.currentGroup || 0;
  if (!st.imageGroups) st.imageGroups = [[]];
  if (!st.imageGroups[groupIdx]) st.imageGroups[groupIdx] = [];
  st.imageGroups[groupIdx].push({ path: st.lastImagePath, type: 'back', seq: st.sequence });
  
  const frontCount = st.fronts?.length || 0;
  const backCount = st.backs.length;
  await bot.sendMessage(chatId, `✅ BACK #${backCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
});

bot.onText(/\/pdf/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);

  const groups = st.imageGroups || [[]];
  
  // Collect all images from all groups and sort by sequence
  const allImages = [];
  for (const group of groups) {
    if (group && group.length > 0) {
      allImages.push(...group);
    }
  }
  
  if (allImages.length === 0) {
    await bot.sendMessage(chatId, "I need at least one complete ID (1 front + 1 back). Send images and mark them as front/back.");
    return;
  }
  
  // Sort all images by sequence number (order received)
  allImages.sort((a, b) => a.seq - b.seq);
  
  // Separate into fronts and backs while maintaining order
  const allFronts = allImages.filter(img => img.type === 'front');
  const allBacks = allImages.filter(img => img.type === 'back');
  
  // Pair them: 1st front with 1st back, 2nd front with 2nd back, etc.
  const pairCount = Math.min(allFronts.length, allBacks.length, 5);
  const pairs = [];
  for (let i = 0; i < pairCount; i++) {
    pairs.push({
      front: allFronts[i].path,
      back: allBacks[i].path
    });
  }
  
  if (pairs.length === 0) {
    await bot.sendMessage(chatId, "I need at least one complete ID (1 front + 1 back). Send images and mark them as front/back.");
    return;
  }

  const jobDir = path.join(ROOT, String(chatId), uuidv4());
  ensureDir(jobDir);

  try {
    const pairsToUse = [];

    // Optional labels (keep OFF to preserve zero changes)
    if (STAMP_LABELS) {
      for (let i = 0; i < pairs.length; i++) {
        const f = path.join(jobDir, `front_${i}_labeled.png`);
        const b = path.join(jobDir, `back_${i}_labeled.png`);
        await stampLabel(pairs[i].front, "FRONT", f);
        await stampLabel(pairs[i].back, "BACK", b);
        pairsToUse.push({ front: f, back: b });
      }
    } else {
      pairsToUse.push(...pairs);
    }

    const outPdf = path.join(jobDir, "pub_exact_layout.pdf");
    
    // Use multi-ID function for automatic grid layout
    await makeMultiIdPdf(pairsToUse, outPdf);

    await bot.sendDocument(chatId, outPdf, {}, { filename: `pub_${pairs.length}ids.pdf` });
    await bot.sendMessage(chatId, `✅ PDF generated with ${pairs.length} ID(s).`);
    
    // Clear after successful generation
    st.fronts = [];
    st.backs = [];
    st.imageGroups = [[]];
    st.currentGroup = 0;
  } catch (e) {
    await bot.sendMessage(chatId, `Failed: ${e.message}`);
  }
});

// Tagging by text: "front" / "back" or any text as separator
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim().toLowerCase();
  
  // If not a command and not front/back, treat as separator
  if (!text.startsWith('/') && text !== "front" && text !== "back") {
    const st = getState(chatId);
    st.currentGroup = (st.currentGroup || 0) + 1;
    if (!st.imageGroups) st.imageGroups = [[]];
    if (!st.imageGroups[st.currentGroup]) {
      st.imageGroups[st.currentGroup] = [];
    }
    await bot.sendMessage(chatId, `✅ Group #${st.currentGroup + 1} started.`);
    return;
  }
  
  if (text !== "front" && text !== "back") return;

  const st = getState(chatId);
  if (!st.lastImagePath) return bot.sendMessage(chatId, "Send an image first, then type front/back.");

  if (text === "front") {
    if (!st.fronts) st.fronts = [];
    if (st.fronts.length >= 5) {
      return bot.sendMessage(chatId, "⚠️ Maximum 5 FRONT images reached.");
    }
    st.sequence = (st.sequence || 0) + 1;
    st.fronts.push({ path: st.lastImagePath, seq: st.sequence });
    
    const groupIdx = st.currentGroup || 0;
    if (!st.imageGroups) st.imageGroups = [[]];
    if (!st.imageGroups[groupIdx]) st.imageGroups[groupIdx] = [];
    st.imageGroups[groupIdx].push({ path: st.lastImagePath, type: 'front', seq: st.sequence });
    
    const frontCount = st.fronts.length;
    const backCount = st.backs?.length || 0;
    await bot.sendMessage(chatId, `✅ FRONT #${frontCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
  }
  
  if (text === "back") {
    if (!st.backs) st.backs = [];
    if (st.backs.length >= 5) {
      return bot.sendMessage(chatId, "⚠️ Maximum 5 BACK images reached.");
    }
    st.sequence = (st.sequence || 0) + 1;
    st.backs.push({ path: st.lastImagePath, seq: st.sequence });
    
    const groupIdx = st.currentGroup || 0;
    if (!st.imageGroups) st.imageGroups = [[]];
    if (!st.imageGroups[groupIdx]) st.imageGroups[groupIdx] = [];
    st.imageGroups[groupIdx].push({ path: st.lastImagePath, type: 'back', seq: st.sequence });
    
    const frontCount = st.fronts?.length || 0;
    const backCount = st.backs.length;
    await bot.sendMessage(chatId, `✅ BACK #${backCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
  }
});

// Receive photos
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);

  const photos = msg.photo || [];
  const best = photos[photos.length - 1];
  if (!best?.file_id) return;

  const userDir = path.join(ROOT, String(chatId));
  ensureDir(userDir);

  const imgPath = path.join(userDir, `upload_${Date.now()}.jpg`);
  try {
    await downloadTelegramFile(best.file_id, imgPath);
    st.lastImagePath = imgPath;
    
    // Check if caption contains front/back indicator
    const caption = (msg.caption || "").toLowerCase();
    
    if (caption.includes("front")) {
      if (!st.fronts) st.fronts = [];
      if (st.fronts.length >= 5) {
        return bot.sendMessage(chatId, "⚠️ Maximum 5 FRONT images reached.");
      }
      st.sequence = (st.sequence || 0) + 1;
      st.fronts.push({ path: imgPath, seq: st.sequence });
      
      const groupIdx = st.currentGroup || 0;
      if (!st.imageGroups) st.imageGroups = [[]];
      if (!st.imageGroups[groupIdx]) st.imageGroups[groupIdx] = [];
      st.imageGroups[groupIdx].push({ path: imgPath, type: 'front', seq: st.sequence });
      
      const frontCount = st.fronts.length;
      const backCount = st.backs?.length || 0;
      await bot.sendMessage(chatId, `✅ FRONT #${frontCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    } else if (caption.includes("back")) {
      if (!st.backs) st.backs = [];
      if (st.backs.length >= 5) {
        return bot.sendMessage(chatId, "⚠️ Maximum 5 BACK images reached.");
      }
      st.sequence = (st.sequence || 0) + 1;
      st.backs.push({ path: imgPath, seq: st.sequence });
      
      const groupIdx = st.currentGroup || 0;
      if (!st.imageGroups) st.imageGroups = [[]];
      if (!st.imageGroups[groupIdx]) st.imageGroups[groupIdx] = [];
      st.imageGroups[groupIdx].push({ path: imgPath, type: 'back', seq: st.sequence });
      
      const frontCount = st.fronts?.length || 0;
      const backCount = st.backs.length;
      await bot.sendMessage(chatId, `✅ BACK #${backCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    } else {
      await bot.sendMessage(chatId, `Image received. Add caption 'Front' or 'Back', or type front/back.`);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `Download failed: ${e.message}. Please try sending the image again.`);
  }
});

// Receive images as document
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);

  const doc = msg.document;
  if (!doc?.file_id) return;

  const filename = (doc.file_name || "").toLowerCase();
  const isImg = filename.endsWith(".png") || filename.endsWith(".jpg") || filename.endsWith(".jpeg") || filename.endsWith(".webp");

  if (!isImg) {
    await bot.sendMessage(chatId, "Please send an image (png/jpg/webp). Users do not need PUB.");
    return;
  }

  const userDir = path.join(ROOT, String(chatId));
  ensureDir(userDir);

  const outPath = path.join(userDir, `${Date.now()}_${path.basename(filename)}`);
  try {
    await downloadTelegramFile(doc.file_id, outPath);
    st.lastImagePath = outPath;
    const frontCount = st.fronts?.length || 0;
    const backCount = st.backs?.length || 0;
    await bot.sendMessage(chatId, `Image received. Type 'front' or 'back' (or /front /back). Current: ${frontCount} fronts, ${backCount} backs.`);
  } catch (e) {
    await bot.sendMessage(chatId, `Download failed: ${e.message}. Please try sending the image again.`);
  }
});

/* ==========
   Startup
   ========== */
console.log("✅ Bot is running...");
