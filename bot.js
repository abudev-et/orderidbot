import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import TelegramBot from "node-telegram-bot-api";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

// Configure sharp for low memory usage on shared hosting
sharp.cache(false);
sharp.concurrency(1);
sharp.simd(false);

const BOT_TOKEN = process.env.BOT_TOKEN;
const STAMP_LABELS = String(process.env.STAMP_LABELS || "false").toLowerCase() === "true";
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;

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
 *   lastImageOrder?: number,
 *   pendingImages?: Array<{path: string, seq: number, ready?: boolean}>,
 *   fronts?: Array<{path: string, seq: number}>,
 *   backs?: Array<{path: string, seq: number}>,
 *   pairs?: Array<{front: string, back: string}>,
 *   currentGroup?: number,
 *   imageGroups?: Array<Array<{path: string, type: string, seq: number}>> // seq is message order
 * }
 */
const state = new Map();
function getState(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, {
      pairs: [],
      fronts: [],
      backs: [],
      currentGroup: 0,
      imageGroups: [[]],
      lastImagePath: null,
      lastImageOrder: null,
      pendingImages: []
    });
  }
  return state.get(chatId);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function queuePendingImage(st, imgPath, order, downloadPromise) {
  if (!st.pendingImages) st.pendingImages = [];
  const item = { path: imgPath, seq: order, ready: false, promise: null };
  if (downloadPromise) {
    item.promise = downloadPromise.then(() => {
      item.ready = true;
      return imgPath;
    });
  } else {
    item.ready = true;
  }
  st.pendingImages.push(item);
  st.pendingImages.sort((a, b) => a.seq - b.seq);
  return item;
}

async function takePendingImage(st) {
  if (!st.pendingImages || st.pendingImages.length === 0) return null;
  st.pendingImages.sort((a, b) => a.seq - b.seq);
  const item = st.pendingImages[0];
  if (!item.ready && item.promise) {
    try {
      await item.promise;
    } catch (e) {
      st.pendingImages.shift();
      return null;
    }
  }
  if (!item.ready) return null;
  st.pendingImages.shift();
  return item;
}

function addLabeledImage(st, type, imgPath, order) {
  if (!st.fronts) st.fronts = [];
  if (!st.backs) st.backs = [];
  const list = type === "front" ? st.fronts : st.backs;
  list.push({ path: imgPath, seq: order });

  const groupIdx = st.currentGroup || 0;
  if (!st.imageGroups) st.imageGroups = [[]];
  if (!st.imageGroups[groupIdx]) st.imageGroups[groupIdx] = [];
  st.imageGroups[groupIdx].push({ path: imgPath, type, seq: order });

  if (st.lastImagePath === imgPath) {
    st.lastImagePath = null;
    st.lastImageOrder = null;
  }

  return { frontCount: st.fronts.length, backCount: st.backs.length };
}

function queueLabel(st, fn) {
  const run = () => Promise.resolve().then(fn);
  st.labelLock = (st.labelLock || Promise.resolve()).then(run, run);
  return st.labelLock;
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
// Back size: 3.40" x 2.20" (244.80 x 158.40 points)
// Front size: +2.4mm on both dimensions (251.60 x 165.20 points)
// Front/back horizontal gap: 8mm (22.68 points)
// Front: at horizontal=0.669", vertical=0.296"
// Back: at horizontal=4.22", vertical=0.302"
// Conversion: 1 inch = 72 points
const LAYOUT = {
  pageWpt: 595.30,
  pageHpt: 841.90,
  frontBox: { x: 44.77, y: 0, w: 251.60, h: 165.20 },
  backBox: { x: 319.05, y: 0, w: 244.80, h: 158.40 }
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
        valign: "top"
      });

      // BACK in measured backBox
      doc.image(backImg, LAYOUT.backBox.x, LAYOUT.backBox.y, {
        fit: [LAYOUT.backBox.w, LAYOUT.backBox.h],
        align: "center",
        valign: "top"
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });

  return outPdf;
}

async function makeMultiIdPdf(pairs, outPdf, flipImages = false) {
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

      const firstFrontX = LAYOUT.frontBox.x;
      const firstBackX = LAYOUT.backBox.x;
      const backYOffset = 0;
      
      // Row spacing: first row at top (0mm), 1.41mm vertical gap between rows
      const rowGap = 1.41 * 72 / 25.4;
      const rowStep = LAYOUT.backBox.h + rowGap;
      const verticalPositions = Array.from({ length: 5 }, (_, i) => i * rowStep);
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
        const topY = verticalPositions[row] ?? verticalPositions[verticalPositions.length - 1];
        const frontY = topY;
        const backY = topY + backYOffset;

        // FRONT
        const frontOptions = {
          fit: [LAYOUT.frontBox.w, LAYOUT.frontBox.h],
          align: "center",
          valign: "top"
        };
        if (flipImages) {
          doc.save();
          doc.translate(frontX + LAYOUT.frontBox.w, frontY);
          doc.scale(-1, 1);  // Flip horizontally
          doc.image(pairs[i].front, 0, 0, frontOptions);
          doc.restore();
        } else {
          doc.image(pairs[i].front, frontX, frontY, frontOptions);
        }

        // BACK
        const backOptions = {
          fit: [LAYOUT.backBox.w, LAYOUT.backBox.h],
          align: "center",
          valign: "top"
        };
        if (flipImages) {
          doc.save();
          doc.translate(backX + LAYOUT.backBox.w, backY);
          doc.scale(-1, 1);  // Flip horizontally
          doc.image(pairs[i].back, 0, 0, backOptions);
          doc.restore();
        } else {
          doc.image(pairs[i].back, backX, backY, backOptions);
        }
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
  state.set(chatId, {
    pairs: [],
    fronts: [],
    backs: [],
    currentGroup: 0,
    imageGroups: [[]],
    lastImagePath: null,
    lastImageOrder: null,
    pendingImages: []
  });
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
  const userId = msg.from.id;
  
  // Check if user is admin
  if (ADMIN_ID && userId === ADMIN_ID) {
    try {
      // Admin: Delete entire data folder
      if (fs.existsSync(ROOT)) {
        fs.rmSync(ROOT, { recursive: true, force: true });
        fs.mkdirSync(ROOT, { recursive: true });
      }
      
      // Clear all chat states
      state.clear();
      
      await bot.sendMessage(chatId, "🔐 Admin Reset: All data deleted from server.");
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Admin reset failed: ${e.message}`);
    }
  } else {
    // Regular user: Reset only their own state and delete their folder
    try {
      const userDir = path.join(ROOT, String(chatId));
      if (fs.existsSync(userDir)) {
        fs.rmSync(userDir, { recursive: true, force: true });
      }
      
      state.set(chatId, {
        pairs: [],
        fronts: [],
        backs: [],
        currentGroup: 0,
        imageGroups: [[]],
        lastImagePath: null,
        lastImageOrder: null,
        pendingImages: []
      });
      await bot.sendMessage(chatId, "✅ Reset done. Your data cleared.");
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ Reset failed: ${e.message}`);
    }
  }
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
  await queueLabel(st, async () => {
    if ((st.fronts?.length || 0) >= 5) {
      return bot.sendMessage(chatId, "?s??,? Maximum 5 FRONT images reached.");
    }

    const img = await takePendingImage(st);
    if (!img) return bot.sendMessage(chatId, "Send an image first, then /front.");

    const counts = addLabeledImage(st, "front", img.path, img.seq);
    const frontCount = counts.frontCount;
    const backCount = counts.backCount;
    await bot.sendMessage(chatId, `?o. FRONT #${frontCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
  });
});

bot.onText(/\/back/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);
  await queueLabel(st, async () => {
    if ((st.backs?.length || 0) >= 5) {
      return bot.sendMessage(chatId, "?s??,? Maximum 5 BACK images reached.");
    }

    const img = await takePendingImage(st);
    if (!img) return bot.sendMessage(chatId, "Send an image first, then /back.");

    const counts = addLabeledImage(st, "back", img.path, img.seq);
    const frontCount = counts.frontCount;
    const backCount = counts.backCount;
    await bot.sendMessage(chatId, `?o. BACK #${backCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
  });
});

bot.onText(/\/pdf/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);

  const groups = st.imageGroups || [[]];
  
  // Collect all images from all groups and sort by message order
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
  
  // Sort all images by message order (avoids async download reordering)
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

  // Store pairs in state for callback handler
  st.pendingPairs = pairs;
  
  // Show orientation selection buttons
  const keyboard = {
    inline_keyboard: [
      [
        { text: "📄 Normal", callback_data: "pdf_normal" },
        { text: "🔄 Flip", callback_data: "pdf_flip" }
      ]
    ]
  };
  
  await bot.sendMessage(
    chatId,
    `📋 Ready to generate PDF with ${pairs.length} ID(s).\n\nChoose orientation:`,
    { reply_markup: keyboard }
  );
});

// Handle button callbacks for PDF orientation
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const st = getState(chatId);
  
  if (data === "user_reset") {
    // Handle reset button click
    await bot.answerCallbackQuery(query.id, { text: "Resetting your data..." });
    
    try {
      const userDir = path.join(ROOT, String(chatId));
      if (fs.existsSync(userDir)) {
        fs.rmSync(userDir, { recursive: true, force: true });
      }
      
      state.set(chatId, {
        pairs: [],
        fronts: [],
        backs: [],
        currentGroup: 0,
        imageGroups: [[]],
        lastImagePath: null,
        lastImageOrder: null,
        pendingImages: []
      });
      await bot.sendMessage(chatId, "✅ Reset done. Your data cleared.\n\nSend new images to start over!");
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ Reset failed: ${e.message}`);
    }
  } else if (data === "pdf_normal" || data === "pdf_flip") {
    const flipImages = data === "pdf_flip";
    
    // Answer callback to remove loading state
    await bot.answerCallbackQuery(query.id, { text: `Generating ${flipImages ? 'flipped' : 'normal'} PDF...` });
    
    const pairs = st.pendingPairs || [];
    if (pairs.length === 0) {
      await bot.sendMessage(chatId, "⚠️ No images found. Please send images again and use /pdf.");
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
      
      // Use multi-ID function with flip option
      await makeMultiIdPdf(pairsToUse, outPdf, flipImages);

      await bot.sendDocument(chatId, outPdf, {}, { filename: `pub_${pairs.length}ids_${flipImages ? 'flipped' : 'normal'}.pdf` });
      
      // Show success message with reset button
      const resetKeyboard = {
        inline_keyboard: [
          [
            { text: "🔄 Reset & Start Over", callback_data: "user_reset" }
          ]
        ]
      };
      
      await bot.sendMessage(
        chatId,
        `✅ PDF generated with ${pairs.length} ID(s) (${flipImages ? 'Flipped' : 'Normal'}).`,
        { reply_markup: resetKeyboard }
      );
      
      // Clear after successful generation
      st.fronts = [];
      st.backs = [];
      st.imageGroups = [[]];
      st.currentGroup = 0;
      st.pendingPairs = null;
      st.lastImagePath = null;
      st.lastImageOrder = null;
      st.pendingImages = [];
    } catch (e) {
      await bot.sendMessage(chatId, `Failed: ${e.message}`);
    }
  }
});

// Tagging by text: "front" / "back" or any text as separator
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (typeof msg.text !== "string") return;
  const text = msg.text.trim().toLowerCase();
  
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

  if (text === "front") {
    await queueLabel(st, async () => {
      if ((st.fronts?.length || 0) >= 5) {
        return bot.sendMessage(chatId, "?s??,? Maximum 5 FRONT images reached.");
      }

      const img = await takePendingImage(st);
      if (!img) return bot.sendMessage(chatId, "Send an image first, then type front/back.");

      const counts = addLabeledImage(st, "front", img.path, img.seq);
      const frontCount = counts.frontCount;
      const backCount = counts.backCount;
      await bot.sendMessage(chatId, `?o. FRONT #${frontCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    });
  }
  
  if (text === "back") {
    await queueLabel(st, async () => {
      if ((st.backs?.length || 0) >= 5) {
        return bot.sendMessage(chatId, "?s??,? Maximum 5 BACK images reached.");
      }

      const img = await takePendingImage(st);
      if (!img) return bot.sendMessage(chatId, "Send an image first, then type front/back.");

      const counts = addLabeledImage(st, "back", img.path, img.seq);
      const frontCount = counts.frontCount;
      const backCount = counts.backCount;
      await bot.sendMessage(chatId, `?o. BACK #${backCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    });
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
    const order = msg.message_id ?? Date.now();
    const caption = (msg.caption || "").toLowerCase();
    const downloadPromise = downloadTelegramFile(best.file_id, imgPath);
    let pending = null;
    if (!caption.includes("front") && !caption.includes("back")) {
      pending = queuePendingImage(st, imgPath, order, downloadPromise);
    }

    await downloadPromise;
    st.lastImagePath = imgPath;
    st.lastImageOrder = order;
    
    // Check if caption contains front/back indicator

    if (caption.includes("front")) {
      if ((st.fronts?.length || 0) >= 5) {
        return bot.sendMessage(chatId, "?s??,? Maximum 5 FRONT images reached.");
      }
      const counts = addLabeledImage(st, "front", imgPath, order);
      const frontCount = counts.frontCount;
      const backCount = counts.backCount;
      await bot.sendMessage(chatId, `?o. FRONT #${frontCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    } else if (caption.includes("back")) {
      if ((st.backs?.length || 0) >= 5) {
        return bot.sendMessage(chatId, "?s??,? Maximum 5 BACK images reached.");
      }
      const counts = addLabeledImage(st, "back", imgPath, order);
      const frontCount = counts.frontCount;
      const backCount = counts.backCount;
      await bot.sendMessage(chatId, `?o. BACK #${backCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    } else {
      if (pending) pending.ready = true;
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
    const order = msg.message_id ?? Date.now();
    const caption = (msg.caption || "").toLowerCase();
    const downloadPromise = downloadTelegramFile(doc.file_id, outPath);

    let pending = null;
    if (!caption.includes("front") && !caption.includes("back")) {
      pending = queuePendingImage(st, outPath, order, downloadPromise);
    }

    await downloadPromise;
    st.lastImagePath = outPath;
    st.lastImageOrder = order;
    if (caption.includes("front")) {
      if ((st.fronts?.length || 0) >= 5) {
        return bot.sendMessage(chatId, "?s??,? Maximum 5 FRONT images reached.");
      }
      const counts = addLabeledImage(st, "front", outPath, order);
      const frontCount = counts.frontCount;
      const backCount = counts.backCount;
      await bot.sendMessage(chatId, `?o. FRONT #${frontCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    } else if (caption.includes("back")) {
      if ((st.backs?.length || 0) >= 5) {
        return bot.sendMessage(chatId, "?s??,? Maximum 5 BACK images reached.");
      }
      const counts = addLabeledImage(st, "back", outPath, order);
      const frontCount = counts.frontCount;
      const backCount = counts.backCount;
      await bot.sendMessage(chatId, `?o. BACK #${backCount}. Total: ${frontCount} fronts, ${backCount} backs. /pdf`);
    } else {
      if (pending) pending.ready = true;
      const frontCount = st.fronts?.length || 0;
      const backCount = st.backs?.length || 0;
      await bot.sendMessage(chatId, `Image received. Type 'front' or 'back' (or /front /back). Current: ${frontCount} fronts, ${backCount} backs.`);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `Download failed: ${e.message}. Please try sending the image again.`);
  }
});

/* ==========
   Startup
   ========== */
console.log("✅ Bot is running...");
