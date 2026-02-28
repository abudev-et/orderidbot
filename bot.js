import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import TelegramBot from "node-telegram-bot-api";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

// Configure sharp for very low memory usage
sharp.cache({ memory: 50, files: 0, items: 0 }); // Strict memory limit
sharp.concurrency(1);
sharp.simd(false);


const BOT_TOKEN = process.env.BOT_TOKEN;
const STAMP_LABELS = process.env.STAMP_LABELS === "true";
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;

if (!BOT_TOKEN) {
    console.error("Missing BOT_TOKEN in .env");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const ROOT = path.resolve("./data");
fs.mkdirSync(ROOT, { recursive: true });
const KNOWN_CHATS_FILE = path.join(ROOT, "known_chats.json");
const knownChats = new Map(); // Changed to Map for metadata
const BLACKLIST_FILE = path.join(ROOT, "blacklist.json");
const blacklistedChats = new Set();
const PRESETS_FILE = path.join(ROOT, "presets.json");

let presets = [
    { name: "Standard ID", w: 8.8, h: 5.6, u: "cm", gap: "small" },
    { name: "Standard ID2", w: 8.9, h: 5.7, u: "cm", gap: "small" },
    { name: "Size 1", w: 1042, h: 646, u: "px", gap: "small" },
    { name: "Size 2", w: 1069, h: 667, u: "px", gap: "small" }
];

function loadPresets() {
    if (!fs.existsSync(PRESETS_FILE)) return savePresets(); // Save defaults if empty
    try {
        const raw = fs.readFileSync(PRESETS_FILE, "utf8");
        presets = JSON.parse(raw);
    } catch (e) {
        console.error(`Failed to load presets: ${e.message}`);
    }
}

function savePresets() {
    try {
        fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
    } catch (e) {
        console.error(`Failed to save presets: ${e.message}`);
    }
}

function loadKnownChats() {
    if (!fs.existsSync(KNOWN_CHATS_FILE)) return;
    try {
        const raw = fs.readFileSync(KNOWN_CHATS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            // Migrate old format (array of IDs)
            parsed.forEach(id => {
                if (Number.isInteger(id)) knownChats.set(id, { id });
            });
        } else if (typeof parsed === 'object') {
            // Load new format (Map object)
            Object.entries(parsed).forEach(([id, info]) => {
                knownChats.set(Number(id), info);
            });
        }
    } catch (e) {
        console.error(`Failed to load known chats: ${e.message}`);
    }
}

function persistKnownChats() {
    try {
        const data = Object.fromEntries(knownChats);
        fs.writeFileSync(KNOWN_CHATS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Failed to save known chats: ${e.message}`);
    }
}

function registerChatId(msgOrId) {
    let chatId, from;
    if (typeof msgOrId === 'object') {
        chatId = msgOrId.chat?.id || msgOrId.from?.id;
        from = msgOrId.from;
    } else {
        chatId = msgOrId;
    }

    if (!Number.isInteger(chatId)) return;

    const existing = knownChats.get(chatId) || { id: chatId };
    let changed = !knownChats.has(chatId);

    if (from) {
        const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
        if (name && existing.name !== name) { existing.name = name; changed = true; }
        if (from.username && existing.username !== from.username) { existing.username = from.username; changed = true; }
    }

    if (changed) {
        knownChats.set(chatId, existing);
        persistKnownChats();
    }
}

function loadBlacklist() {
    if (!fs.existsSync(BLACKLIST_FILE)) return;
    try {
        const raw = fs.readFileSync(BLACKLIST_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) parsed.forEach(id => blacklistedChats.add(id));
    } catch (e) {
        console.error(`Failed to load blacklist: ${e.message}`);
    }
}

function saveBlacklist() {
    try {
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(Array.from(blacklistedChats), null, 2));
    } catch (e) {
        console.error(`Failed to save blacklist: ${e.message}`);
    }
}

function persistState(chatId) {
    const st = state.get(chatId);
    if (!st) return;
    try {
        const userDir = path.join(ROOT, String(chatId));
        ensureDir(userDir);
        const data = {
            settings: st.settings,
            fronts: st.fronts,
            backs: st.backs,
            currentGroup: st.currentGroup,
            imageGroups: st.imageGroups,
            userPresets: st.userPresets || []
        };

        fs.writeFileSync(path.join(userDir, "state.json"), JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Status save failed for ${chatId}: ${e.message}`);
    }
}

loadKnownChats();
loadBlacklist();
loadPresets();



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
const processedMessageIds = new Set(); // To prevent double processing
// Cleanup old message IDs periodically
setInterval(() => processedMessageIds.clear(), 10 * 60 * 1000); // Clear every 10 mins


/**
 * A4 Paired ID Layout Calculator (Unit-Aware + Dynamic Gap + 5 Pairs)
 * Based on 300 DPI standard (2480 x 3508)
 */
function calculateLayout(boxWidth, boxHeight, unitType = "px", gapSizeOption = "small", topMarginVal = 15, topMarginUnit = "px", vertGapChoice = 4) {
    const DPI = 300;
    const A4_WIDTH = 2480;
    const A4_HEIGHT = 3508;

    const toPx = (val, unit) => {
        if (unit === "px") return val;
        if (unit === "inch") return val * 300;
        if (unit === "mm") return (val / 25.4) * 300;
        if (unit === "cm") return (val / 2.54) * 300;
        return val;
    };

    const boxWidthPx = toPx(boxWidth, unitType);
    const boxHeightPx = toPx(boxHeight, unitType);
    const topMarginPx = toPx(topMarginVal, topMarginUnit);

    // Center Gap
    let centerGap = 54;
    if (gapSizeOption === "medium") centerGap = Math.max(54, boxWidthPx * 0.08);
    else if (gapSizeOption === "large") centerGap = Math.max(54, boxWidthPx * 0.15);

    const totalPairWidth = (boxWidthPx * 2) + centerGap;
    if (totalPairWidth > A4_WIDTH) {
        return { fitsA4: false, error: `Side Error: Box total width (${Math.round(totalPairWidth)}px) exceeds A4 width (${A4_WIDTH}px). Reduce box size or center gap.` };
    }
    const leftMargin = (A4_WIDTH - totalPairWidth) / 2;

    // Vertical Gap (4 Choice System)
    const MIN_BOTTOM_MARGIN = 15;
    const MIN_VERTICAL_GAP = 15;
    const totalBoxHeight = boxHeightPx * 5;
    const availableVSpace = A4_HEIGHT - totalBoxHeight - topMarginPx - MIN_BOTTOM_MARGIN;

    if (availableVSpace < (MIN_VERTICAL_GAP * 4)) {
        const needed = (MIN_VERTICAL_GAP * 4) + totalBoxHeight + topMarginPx + MIN_BOTTOM_MARGIN;
        return { fitsA4: false, error: `Length Error: Layout exceeds A4 height. Needed ${Math.round(needed)}px, available ${A4_HEIGHT}px. Reduce box size, top margin, or use fewer IDs.` };
    }

    const maxGap = Math.floor(availableVSpace / 4);
    const gaps = [
        Math.max(MIN_VERTICAL_GAP, Math.floor(maxGap * 0.25)),
        Math.max(MIN_VERTICAL_GAP, Math.floor(maxGap * 0.5)),
        Math.max(MIN_VERTICAL_GAP, Math.floor(maxGap * 0.75)),
        maxGap
    ];

    const verticalGap = gaps[vertGapChoice - 1] || maxGap;
    const bottomMargin = A4_HEIGHT - (topMarginPx + totalBoxHeight + (verticalGap * 4));

    return {
        boxWidthPx, boxHeightPx, centerGap, totalPairWidth,
        leftMargin, rightMargin: leftMargin, topMarginPx,
        verticalGap, bottomMargin, fitsA4: true,
        widthPx: A4_WIDTH, heightPx: A4_HEIGHT,
        gapChoices: gaps
    };
}

function getState(chatId) {
    if (!state.has(chatId)) {
        const defaultSettings = {
            mode: "default", boxWidth: 85.5, boxHeight: 54, unit: "mm", gap: "small",
            topMargin: 15, topMarginUnit: "px", outputFormat: "jpg", vertGapChoice: 4
        };

        const userDir = path.join(ROOT, String(chatId));
        let saved = {};
        if (fs.existsSync(path.join(userDir, "state.json"))) {
            try { saved = JSON.parse(fs.readFileSync(path.join(userDir, "state.json"), "utf8")); } catch (e) { }
        }
        const settings = { ...defaultSettings, ...(saved.settings || {}) };
        settings.layout = calculateLayout(settings.boxWidth, settings.boxHeight, settings.unit, settings.gap, settings.topMargin, settings.topMarginUnit, settings.vertGapChoice);

        const st = {
            settings: settings,

            fronts: saved.fronts || [],
            backs: saved.backs || [],
            currentGroup: saved.currentGroup || 0,
            imageGroups: saved.imageGroups || [[]],
            userPresets: saved.userPresets || [],
            pendingImages: [],
            pendingPages: null,
            awaitingSetting: null,
            lastStatusMsgId: null,
            pairs: [],
            lastImagePath: null,
            lastImageOrder: null,
            awaitingNews: false
        };
        state.set(chatId, st);
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

function buildPairsFromGroups(groups, maxPairsPerPage = 5) {
    const allPairs = [];
    let incompleteGroups = 0;
    const safeGroups = Array.isArray(groups) ? groups : [];

    // Collect all pairs first
    for (const group of safeGroups) {
        if (!group || group.length === 0) continue;

        const sorted = [...group].sort((a, b) => a.seq - b.seq);
        const fronts = sorted.filter((img) => img.type === "front");
        const backs = sorted.filter((img) => img.type === "back");
        const groupPairs = Math.min(fronts.length, backs.length);

        if (fronts.length !== backs.length) incompleteGroups += 1;

        for (let i = 0; i < groupPairs; i++) {
            allPairs.push({ front: fronts[i].path, back: backs[i].path });
        }
    }

    // Split pairs into pages
    const pages = [];
    for (let i = 0; i < allPairs.length; i += maxPairsPerPage) {
        const pagePairs = allPairs.slice(i, i + maxPairsPerPage);
        pages.push({
            pairs: pagePairs,
            startIndex: i,
            endIndex: Math.min(i + maxPairsPerPage, allPairs.length),
            pageNumber: Math.floor(i / maxPairsPerPage) + 1
        });
    }

    return { 
        pages, 
        totalPairs: allPairs.length, 
        incompleteGroups,
        totalPages: pages.length 
    };
}

async function broadcastNews(message) {
    const chatIds = Array.from(knownChats.keys());
    let sent = 0;
    let failed = 0;

    for (const id of chatIds) {
        try {
            await bot.sendMessage(id, message);
            sent += 1;
        } catch (e) {
            failed += 1;
        }
    }

    return { sent, failed, total: chatIds.length };
}

async function downloadTelegramFile(fileId, outPath, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const link = await bot.getFileLink(fileId);
            const res = await fetch(link);
            if (!res.ok) throw new Error("Failed to download file from Telegram");
            const buf = Buffer.from(await res.arrayBuffer());

            // Early Memory Optimization: Downsize massive images immediately on download
            // This saves RAM during later PDF/Composite operations
            let pipeline = sharp(buf);
            const meta = await pipeline.metadata();
            if (meta.width > 2500 || meta.height > 2500) {
                pipeline = pipeline.resize(2500, 2500, { fit: 'inside', withoutEnlargement: true });
            }
            await pipeline.jpeg({ quality: 90 }).toFile(outPath);
            return outPath;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error(`Download failed: ${lastError.message}`);
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
      <rect x="${x}" y="${y}" rx="10" ry="10" width="${boxW}" height="${boxH}" fill="rgba(0,0,0,0.55)" />
      <text x="${x + pad}" y="${y + Math.floor(boxH * 0.75)}" font-family="Arial" font-size="${fontSize}" font-weight="700" fill="white">${labelText}</text>
    </svg>
  `.trim();
    await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPath);
    return outPath;
}

const pxToPt = (px) => (px * 72) / 300;
const ptToPx = (pt) => (pt * 300) / 72;

async function makeSinglePagePdf(frontImg, backImg, outPdf, layout) {
    const doc = new PDFDocument({ autoFirstPage: false });
    await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(outPdf);
        doc.pipe(stream);
        stream.on("finish", resolve);
        stream.on("error", reject);
        try {
            doc.addPage({ size: [pxToPt(layout.widthPx), pxToPt(layout.heightPx)], margin: 0 });
            const x1 = layout.leftMargin;
            const x2 = layout.leftMargin + layout.boxWidthPx + layout.centerGap;
            const y = layout.topMarginPx;
            doc.image(frontImg, pxToPt(x1), pxToPt(y), { width: pxToPt(layout.boxWidthPx), height: pxToPt(layout.boxHeightPx) });
            doc.image(backImg, pxToPt(x2), pxToPt(y), { width: pxToPt(layout.boxWidthPx), height: pxToPt(layout.boxHeightPx) });
            doc.end();
        } catch (e) { reject(e); }
    });
    return outPdf;
}

async function makeMultiIdPdf(pages, outPdf, layout, flipImages = false, swapSides = false) {
    const doc = new PDFDocument({ autoFirstPage: false });
    await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(outPdf);
        doc.pipe(stream);
        stream.on("finish", resolve);
        stream.on("error", reject);
        try {
            pages.forEach((page, pageIndex) => {
                // Add page for each iteration (including first page)
                doc.addPage({ size: [pxToPt(layout.widthPx), pxToPt(layout.heightPx)], margin: 0 });
                
                const x1 = swapSides ? (layout.leftMargin + layout.boxWidthPx + layout.centerGap) : layout.leftMargin;
                const x2 = swapSides ? layout.leftMargin : (layout.leftMargin + layout.boxWidthPx + layout.centerGap);
                const topStart = layout.topMarginPx;
                const verticalGap = layout.verticalGap;
                
                for (let i = 0; i < page.pairs.length; i++) {
                    const y = topStart + (i * (layout.boxHeightPx + verticalGap));
                    const opts = { width: pxToPt(layout.boxWidthPx), height: pxToPt(layout.boxHeightPx) };
                    if (flipImages) {
                        doc.save().translate(pxToPt(x1 + layout.boxWidthPx), pxToPt(y)).scale(-1, 1).image(page.pairs[i].front, 0, 0, opts).restore();
                        doc.save().translate(pxToPt(x2 + layout.boxWidthPx), pxToPt(y)).scale(-1, 1).image(page.pairs[i].back, 0, 0, opts).restore();
                    } else {
                        doc.image(page.pairs[i].front, pxToPt(x1), pxToPt(y), opts);
                        doc.image(page.pairs[i].back, pxToPt(x2), pxToPt(y), opts);
                    }
                }
            });
            doc.end();
        } catch (e) { reject(e); }
    });
    return outPdf;
}

async function makeMultiIdImage(pages, outFile, layout, format = "jpg", flipImages = false, swapSides = false) {
    // Create tall stacked image with all pages
    const totalPairs = pages.reduce((sum, page) => sum + page.pairs.length, 0);
    const totalHeight = Math.max(1, totalPairs * (layout.boxHeightPx + layout.verticalGap) - layout.verticalGap);
    let background = sharp({ create: { width: layout.widthPx, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } } });

    const composites = [];
    
    // Process all images first to avoid async/await issues
    for (const page of pages) {
        const x1 = swapSides ? (layout.leftMargin + layout.boxWidthPx + layout.centerGap) : layout.leftMargin;
        const x2 = swapSides ? layout.leftMargin : (layout.leftMargin + layout.boxWidthPx + layout.centerGap);
        const pageTopStart = pages.indexOf(page) * (layout.boxHeightPx + layout.verticalGap) * 5; // Max 5 pairs per page
        
        for (let i = 0; i < page.pairs.length; i++) {
            const y = pageTopStart + (i * (layout.boxHeightPx + layout.verticalGap));

            // Process front image
            let frontBuffer = await sharp(page.pairs[i].front)
                .resize(Math.round(layout.boxWidthPx), Math.round(layout.boxHeightPx), { fit: 'fill' })
                .extend({
                    top: 1, bottom: 1, left: 1, right: 1,
                    background: { r: 200, g: 200, b: 200, alpha: 1 }
                })
                .resize(Math.round(layout.boxWidthPx), Math.round(layout.boxHeightPx))
                .toBuffer();

            if (flipImages) frontBuffer = await sharp(frontBuffer).flop().toBuffer();

            // Process back image
            let backBuffer = await sharp(page.pairs[i].back)
                .resize(Math.round(layout.boxWidthPx), Math.round(layout.boxHeightPx), { fit: 'fill' })
                .extend({
                    top: 1, bottom: 1, left: 1, right: 1,
                    background: { r: 200, g: 200, b: 200, alpha: 1 }
                })
                .resize(Math.round(layout.boxWidthPx), Math.round(layout.boxHeightPx))
                .toBuffer();

            if (flipImages) backBuffer = await sharp(backBuffer).flop().toBuffer();

            composites.push({ input: frontBuffer, left: Math.round(x1), top: Math.round(y) });
            composites.push({ input: backBuffer, left: Math.round(x2), top: Math.round(y) });
        }
    }

    background = background.composite(composites);

    if (format === "png") await background.png().toFile(outFile);
    else if (format === "tiff") await background.tiff({ compression: 'deflate', predictor: 'horizontal' }).toFile(outFile);
    else await background.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).withMetadata({ density: 300 }).toFile(outFile);

    return outFile;
}

/**
 * 3) Telegram bot logic (Flattened & Protected)
 */

function getMainKeyboard(chatId) {
    const rows = [
        [{ text: "🚀 Start" }, { text: "📋 Status" }],
        [{ text: "⚙️ Settings" }, { text: "⏭️ Next ID" }],
        [{ text: "🔄 Reset" }, { text: "📄 Print" }]
    ];
    if (ADMIN_ID && chatId === ADMIN_ID) {
        rows.push([{ text: "🛠️ Admin" }]);
    }
    return {
        keyboard: rows,
        resize_keyboard: true,
        persistent: true
    };
}



async function handleCommand(chatId, text, msg) {
    if (blacklistedChats.has(chatId)) return;
    const st = getState(chatId);
    const cmd = (text || "").toLowerCase().trim();

    // Admin Commands
    if (ADMIN_ID && chatId === ADMIN_ID) {
        if (cmd === "/users") {
            const users = Array.from(knownChats.values());
            let list = `👥 **Active Users** (${users.length})\n\n`;
            users.forEach(u => {
                const namePart = u.name ? `**${u.name}** ` : "";
                const userPart = u.username ? `(@${u.username}) ` : "";
                list += `• ${namePart}${userPart}\`${u.id}\`\n`;
            });
            return bot.sendMessage(chatId, list, { parse_mode: "Markdown" });
        }
        if (cmd.startsWith("/block")) {
            const target = parseInt(cmd.split(" ")[1]);
            if (target && !isNaN(target)) {
                blacklistedChats.add(target);
                saveBlacklist();
                return bot.sendMessage(chatId, `🚫 User \`${target}\` has been blacklisted.`, { parse_mode: "Markdown" });
            }
            return bot.sendMessage(chatId, "Usage: `/block <chatId>`", { parse_mode: "Markdown" });
        }
        if (cmd.startsWith("/unblock")) {
            const target = parseInt(cmd.split(" ")[1]);
            if (target && !isNaN(target)) {
                blacklistedChats.delete(target);
                saveBlacklist();
                return bot.sendMessage(chatId, `✅ User \`${target}\` removed from blacklist.`, { parse_mode: "Markdown" });
            }
            return bot.sendMessage(chatId, "Usage: `/unblock <chatId>`", { parse_mode: "Markdown" });
        }
        if (cmd === "/blacklist") {
            const bl = Array.from(blacklistedChats);
            let list = `🚫 **Blacklisted Users** (${bl.length})\n\n`;
            bl.forEach(id => list += `• \`${id}\`\n`);
            return bot.sendMessage(chatId, list, { parse_mode: "Markdown" });
        }
        if (cmd === "/broadcast") {
            return bot.sendMessage(chatId, "📢 To broadcast, reply to any message (text, photo, etc.) with `/broadcast` or send it as a caption.");
        }
        if (cmd === "/admin") {
            const kb = {
                inline_keyboard: [
                    [{ text: "👥 Manage Users", callback_data: "adm_view_users" }, { text: "🚫 Blacklist", callback_data: "adm_view_blacklist" }],
                    [{ text: "📏 Presets", callback_data: "adm_view_presets" }, { text: "📢 Send Broadcast", callback_data: "adm_broadcast_trigger" }],
                    [{ text: "❌ Close Admin", callback_data: "close_admin" }]
                ]
            };
            return bot.sendMessage(chatId, "🛠️ **Admin Management Panel**\nControl users and presets via buttons below:", { parse_mode: "Markdown", reply_markup: kb });
        }

        if (cmd.startsWith("/addpreset")) {

            const parts = cmd.split(" ");
            if (parts.length >= 6) {
                const name = parts[1], w = parseFloat(parts[2]), h = parseFloat(parts[3]), u = parts[4], gap = parts[5];
                if (!isNaN(w) && !isNaN(h)) {
                    presets.push({ name, w, h, u, gap });
                    savePresets();
                    return bot.sendMessage(chatId, `✅ Preset "${name}" (${w}x${h} ${u}) added.`);
                }
            }
            return bot.sendMessage(chatId, "Usage: `/addpreset <Name> <W> <H> <Unit> <GapChoice>`", { parse_mode: "Markdown" });
        }
        if (cmd.startsWith("/delpreset")) {
            const name = cmd.split(" ")[1];
            const initialLen = presets.length;
            presets = presets.filter(p => p.name.toLowerCase() !== name?.toLowerCase());
            if (presets.length < initialLen) {
                savePresets();
                return bot.sendMessage(chatId, `✅ Preset "${name}" deleted.`);
            }
            return bot.sendMessage(chatId, `❌ Preset "${name}" not found.`);
        }
    }


    if (cmd === "/start" || cmd === "🚀 start") {
        registerChatId(chatId);
        return bot.sendMessage(chatId, "✅ Bot Ready! Send images and mark as front/back.\nUse /settings to customize layout.", { reply_markup: getMainKeyboard(chatId) });
    }


    if (cmd === "/settings" || cmd === "⚙️ settings") {
        return renderSettings(chatId);
    }

    if (cmd === "/admin" || cmd === "🛠️ admin") {
        return handleCommand(chatId, "/admin", msg);
    }

    if (cmd === "/status" || cmd === "📋 status") {
        return sendCounterMsgCustom(chatId);
    }

    if (cmd === "/reset" || cmd === "🔄 reset") {
        const userId = msg?.from?.id;
        // Simplified Reset: Only clear progress/files, keep settings safe
        const userDir = path.join(ROOT, String(chatId));
        if (fs.existsSync(userDir)) {
            const files = fs.readdirSync(userDir);
            for (const f of files) {
                try {
                    // Only delete image files, skip system files that may be locked
                    if (f !== "state.json" && (f.startsWith('d_') || f.includes('front') || f.includes('back'))) {
                        fs.unlinkSync(path.join(userDir, f));
                    }
                } catch (e) {
                    // Ignore permission errors during cleanup
                    console.error(`Failed to delete ${f}:`, e.message);
                }
            }
        }

        st.fronts = []; st.backs = []; st.imageGroups = [[]]; st.currentGroup = 0;
        st.pendingImages = []; st.pendingPairs = null; st.pendingPages = null; st.lastStatusMsgId = null;
        st.awaitingSetting = null; st.lastBroadcastConfirmId = null;
        persistState(chatId);

        // Clear status and send fresh one
        st.lastStatusMsgId = null;
        persistState(chatId);
        return sendCounterMsgCustom(chatId);
    }



    if (cmd === "/next" || cmd === "⏭️ next id") {
        st.currentGroup = (st.currentGroup || 0) + 1;
        if (!st.imageGroups[st.currentGroup]) st.imageGroups[st.currentGroup] = [];
        persistState(chatId);
        return sendCounterMsgCustom(chatId);
    }

    if (cmd === "/print" || cmd === "📄 print" || cmd === "print") {
        const groups = st.imageGroups || [[]];
        const { pages, totalPairs, totalPages } = buildPairsFromGroups(groups);
        if (totalPairs === 0) return bot.sendMessage(chatId, "❌ Error: No complete pairs found. Add both front and back images.");
        if (!st.settings.layout.fitsA4) return bot.sendMessage(chatId, "❌ Error: Layout doesn't fit A4. Check /settings.");

        st.pendingPages = pages;
        const format = st.settings.outputFormat.toUpperCase();
        let message = `📋 Ready for ${format}. Found ${totalPairs} pairs across ${totalPages} page(s).\n\nChoose orientation:`;
        
        if (totalPages > 1) {
            message += `\n📄 **Multi-page output will be generated**`;
        }
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "📄 Normal", callback_data: "print_normal" }, { text: "Reverse", callback_data: "print_reverse" }],
                [{ text: "🔄 Flip + Reverse", callback_data: "print_flip" }]
            ]
        };
        return bot.sendMessage(chatId, message, { reply_markup: keyboard });
    }
}




// bot.onText removed to prevent duplicate routing with bot.on("message")


bot.on("callback_query", handleCallback);

async function handleCallback(query) {
    const chatId = query.message.chat.id;
    if (blacklistedChats.has(chatId)) return;
    registerChatId(query);
    const queryId = query.id;

    // Prevent double processing
    if (processedMessageIds.has("q:" + queryId)) return;
    processedMessageIds.add("q:" + queryId);

    await bot.answerCallbackQuery(queryId).catch(() => { });


    const data = query.data;
    const st = getState(chatId);

    if (data === "trigger_print") {
        return handleCommand(chatId, "/print", query);
    }
    if (data === "trigger_reset") {
        return handleCommand(chatId, "/reset", query);
    }

    // Settings & Navigation Handling
    if (data.startsWith("set_") || data.startsWith("toggle_") || data === "restore_defaults" || data.startsWith("p_") || data === "refresh_settings" || data === "close_settings") {
        const ns = st.settings;

        if (data === "close_settings") {
            return bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
        }

        if (data === "refresh_settings") {
            // Just re-renders the main settings menu below
        } else if (data === "set_mode") {

            ns.mode = ns.mode === "default" ? "custom" : "default";
            if (ns.mode === "default") {
                ns.boxWidth = 85.5; ns.boxHeight = 54; ns.unit = "mm"; ns.gap = "small"; ns.vertGapChoice = 4; ns.topMargin = 15; ns.topMarginUnit = "px";
            }
        } else if (data === "set_size") {
            return renderSizeMenu(chatId, query.message.message_id);
        } else if (data === "set_size_custom") {

            st.awaitingSetting = "set_size";
            return bot.sendMessage(chatId, "✏️ Enter [Width * Height Unit]\nExample: `8.8 * 5.6 cm` or `1000 * 600 px` or `88 * 56 mm`", { parse_mode: "Markdown" });
        } else if (data.startsWith("p_user_sel_")) {
            const idx = parseInt(data.replace("p_user_sel_", ""));
            const p = st.userPresets[idx];
            if (p) {
                ns.boxWidth = p.w; ns.boxHeight = p.h; ns.unit = p.u; ns.gap = p.gap || ns.gap;
                ns.mode = "custom";
            }
        } else if (data.startsWith("p_user_del_")) {
            const idx = parseInt(data.replace("p_user_del_", ""));
            st.userPresets.splice(idx, 1);
            persistState(chatId);
            bot.answerCallbackQuery(queryId, { text: "Preset Deleted" });
            return renderSizeMenu(chatId, query.message.message_id);
        } else if (data === "p_user_save") {



            st.awaitingSetting = "save_user_preset";
            return bot.sendMessage(chatId, "💾 **Save current size**\nEnter a nickname for this size (e.g., 'My Badge'):", { parse_mode: "Markdown" });
        } else if (data.startsWith("p_sel_")) {
            const idx = parseInt(data.replace("p_sel_", ""));
            const p = presets[idx];
            if (p) {
                ns.boxWidth = p.w; ns.boxHeight = p.h; ns.unit = p.u; ns.gap = p.gap || ns.gap;
                ns.mode = "custom";
            }
        } else if (data === "set_gap") {
            const g = ["small", "medium", "large"];
            ns.gap = g[(g.indexOf(ns.gap) + 1) % g.length];
        } else if (data === "set_vgap") {
            ns.vertGapChoice = (ns.vertGapChoice % 4) + 1;
        } else if (data === "set_format") {
            const f = ["jpg", "png", "tiff", "pdf"];
            ns.outputFormat = f[(f.indexOf(ns.outputFormat) + 1) % f.length];
        } else if (data === "toggle_margin") {
            const margins = [15, 20, 25, 30, 35, 40, 45, 50];
            ns.topMargin = margins[(margins.indexOf(ns.topMargin) + 1) % margins.length];
            ns.topMarginUnit = "px";
        }

        // Re-render the main settings menu for any change
        st.settings.layout = calculateLayout(st.settings.boxWidth, st.settings.boxHeight, st.settings.unit, st.settings.gap, st.settings.topMargin, st.settings.topMarginUnit, st.settings.vertGapChoice);
        persistState(chatId);
        return renderSettings(chatId, query.message.message_id);
    }


    // Admin Interactive Handlers
    if (data.startsWith("adm_")) {
        if (chatId !== ADMIN_ID) return bot.answerCallbackQuery(queryId, { text: "Unauthorized" });

        if (data === "adm_view_users") {
            const users = Array.from(knownChats.values());
            const kb = {
                inline_keyboard: users.map(u => ([
                    { text: `👤 ${u.name || u.id}`, callback_data: `adm_user_info_${u.id}` },
                    { text: blacklistedChats.has(u.id) ? "✅ Unblock" : "🚫 Block", callback_data: blacklistedChats.has(u.id) ? `adm_unblock_${u.id}` : `adm_block_${u.id}` }
                ]))
            };
            kb.inline_keyboard.push([{ text: "⬅️ Back", callback_data: "adm_back_main" }]);
            return bot.editMessageText(`👥 **Manage Users** (${users.length})\nSelect a user to view details:`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: kb }).catch(() => { });
        }

        if (data === "adm_view_blacklist") {
            const bl = Array.from(blacklistedChats);
            const kb = {
                inline_keyboard: bl.map(u => ([
                    { text: `🚫 ${u}`, callback_data: "noop" },
                    { text: "✅ Unblock", callback_data: `adm_unblock_${u}` }
                ]))
            };
            kb.inline_keyboard.push([{ text: "⬅️ Back", callback_data: "adm_back_main" }]);
            return bot.editMessageText(`🚫 **Blacklist** (${bl.length})\nSelect a user to restore access:`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: kb }).catch(() => { });
        }

        if (data === "adm_view_presets") {
            const kb = {
                inline_keyboard: presets.map(p => ([
                    { text: `${p.name} (${p.w}${p.u})`, callback_data: "noop" },
                    { text: "🗑️ Delete", callback_data: `adm_del_p_${presets.indexOf(p)}` }
                ]))
            };
            kb.inline_keyboard.push([{ text: "➕ Add New Preset", callback_data: "adm_add_start" }]);
            kb.inline_keyboard.push([{ text: "⬅️ Back", callback_data: "adm_back_main" }]);
            return bot.editMessageText(`📏 **Manage Presets**\nView or delete standard size options:`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: kb }).catch(() => { });
        }

        if (data.startsWith("adm_block_")) {
            const target = parseInt(data.replace("adm_block_", ""));
            blacklistedChats.add(target);
            saveBlacklist();
            bot.answerCallbackQuery(queryId, { text: "User Blocked" });
            return bot.editMessageText(`✅ User ${target} blacklisted.`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Users", callback_data: "adm_view_users" }]] } });
        }

        if (data.startsWith("adm_unblock_")) {
            const target = parseInt(data.replace("adm_unblock_", ""));
            blacklistedChats.delete(target);
            saveBlacklist();
            bot.answerCallbackQuery(queryId, { text: "User Unblocked" });
            return bot.editMessageText(`✅ User ${target} unblocked.`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Blacklist", callback_data: "adm_view_blacklist" }]] } });
        }

        if (data.startsWith("adm_del_p_")) {
            const idx = parseInt(data.replace("adm_del_p_", ""));
            const p = presets[idx];
            if (p) {
                presets.splice(idx, 1);
                savePresets();
                bot.answerCallbackQuery(queryId, { text: "Preset Deleted" });
            }
            return bot.editMessageText("✅ Preset deleted.", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Presets", callback_data: "adm_view_presets" }]] } });
        }

        if (data.startsWith("adm_user_info_")) {
            const targetId = parseInt(data.replace("adm_user_info_", ""));
            const info = knownChats.get(targetId);
            if (!info) return bot.answerCallbackQuery(queryId, { text: "User not found" });

            const tst = getState(targetId);
            const s = tst.settings;
            const { pairs } = buildPairsFromGroups(tst.imageGroups);
            const isBlocked = blacklistedChats.has(targetId);

            let profile = `👤 **User Profile: ${info.name || "Unknown"}**\n`;
            profile += `🆔 ID: \`${targetId}\`\n`;
            profile += `👤 Username: ${info.username ? "@" + info.username : "None"}\n`;
            profile += `🚫 Status: ${isBlocked ? "❌ Blocked" : "✅ Active"}\n\n`;
            profile += `⚙️ **Settings**\n`;
            profile += `📏 Size: ${s.boxWidth}x${s.boxHeight} ${s.unit}\n`;
            profile += `📄 Format: ${s.outputFormat.toUpperCase()}\n`;
            profile += `↕️ Top Margin: ${s.topMargin}px\n\n`;
            profile += `📊 **Progress**\n`;
            profile += `✅ Ready Pairs: ${pairs.length}/5\n`;
            profile += `📍 Current Group: #${tst.currentGroup + 1}\n`;
            profile += `📥 Pending: ${tst.pendingImages?.length || 0} images`;

            const kb = {
                inline_keyboard: [
                    [{ text: isBlocked ? "✅ Unblock User" : "🚫 Block User", callback_data: isBlocked ? `adm_unblock_${targetId}` : `adm_block_${targetId}` }],
                    [{ text: "⬅️ Back to Users", callback_data: "adm_view_users" }]
                ]
            };

            return bot.editMessageText(profile, { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: kb }).catch(() => { });
        }

        if (data === "adm_add_start") {
            bot.answerCallbackQuery(queryId);
            return bot.sendMessage(chatId, "➕ **Add New Preset**\nUse the command format:\n`/addpreset <Name> <W> <H> <Unit> <GapChoice>`\n\nExample:\n`/addpreset ID 85.5 54 mm small`", { parse_mode: "Markdown" });
        }

        if (data === "adm_broadcast_trigger") {
            st.awaitingSetting = "broadcast_msg";
            st.broadcastQueue = [];
            bot.answerCallbackQuery(queryId);
            return bot.sendMessage(chatId, "📢 **Broadcast Mode: Collection**\nSend any texts, photos, or files. They will be added to a queue.\n\nWhen ready, click **Broadcast Now** below.", {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "🚀 Broadcast Now (0 messages)", callback_data: "adm_broadcast_now" }, { text: "❌ Cancel", callback_data: "adm_broadcast_cancel" }]] }
            });
        }

        if (data === "adm_broadcast_now") {
            const q = st.broadcastQueue || [];
            if (q.length === 0) return bot.answerCallbackQuery(queryId, { text: "Queue is empty!" });

            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => { });

            st.awaitingSetting = null;
            st.broadcastQueue = [];
            st.lastBroadcastConfirmId = null;
            persistState(chatId);

            // Collect full message objects to check for media groups
            const messages = [];
            for (const msgId of q) {
                // Technically we can't 'get' the message object back easily from just an ID in this bot's current state
                // unless we stored them. For broadcastNow, we'll maintain individual copyMessage for now
                // BUT for the quick /broadcast we can do better.
            }

            const userIds = Array.from(knownChats.keys());
            let sent = 0;
            for (const uId of userIds) {
                if (ADMIN_ID && uId === ADMIN_ID) continue;
                for (const msgId of q) {
                    try {
                        await bot.copyMessage(uId, chatId, msgId);
                        sent++;
                    } catch (e) { }
                }
            }
            bot.answerCallbackQuery(queryId, { text: "Broadcasting..." });
            return bot.sendMessage(chatId, `📢 Broadcast complete. Sent ${q.length} messages to ${sent} total recipients.`, { reply_markup: getMainKeyboard(chatId) });
        }


        if (data === "adm_broadcast_cancel") {
            // Remove buttons from the trigger message
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => { });

            st.awaitingSetting = null;
            st.broadcastQueue = [];
            st.lastBroadcastConfirmId = null;
            persistState(chatId);
            bot.answerCallbackQuery(queryId, { text: "Broadcast cancelled" });
            return bot.sendMessage(chatId, "❌ Broadcast Mode Cancelled. Queue cleared.", { reply_markup: getMainKeyboard(chatId) });
        }

        if (data === "adm_back_main") {
            const kb = {
                inline_keyboard: [
                    [{ text: "👥 Manage Users", callback_data: "adm_view_users" }, { text: "🚫 Blacklist", callback_data: "adm_view_blacklist" }],
                    [{ text: "📏 Presets", callback_data: "adm_view_presets" }, { text: "📢 Send Broadcast", callback_data: "adm_broadcast_trigger" }],
                    [{ text: "❌ Close Admin", callback_data: "close_admin" }]
                ]
            };
            return bot.editMessageText("🛠️ **Admin Management Panel**", { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: kb });
        }


        if (data === "adm_help_bc") {
            bot.answerCallbackQuery(queryId);
            return bot.sendMessage(chatId, "📢 **Broadcast Instructions**\nTo broadcast, simply **reply** to any message or media with `/broadcast` and it will be sent to all users.", { parse_mode: "Markdown" });
        }

        if (data === "close_admin") {
            return bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
        }
    }

    if (data.startsWith("print_")) {

        const flip = data === "print_flip";
        const swap = data.includes("reverse") || flip;
        const format = st.settings.outputFormat;
        const userDir = path.join(ROOT, String(chatId));
        ensureDir(userDir);
        const ext = format === "pdf" ? "pdf" : format === "tiff" ? "tiff" : format === "png" ? "png" : "jpg";
        const outFile = path.join(userDir, `print_${Date.now()}_${uuidv4().slice(0, 8)}.${ext}`);

        try {
            if (format === "pdf") await makeMultiIdPdf(st.pendingPages, outFile, st.settings.layout, flip, swap);
            else await makeMultiIdImage(st.pendingPages, outFile, st.settings.layout, format, flip, swap);
            
            // Send file with page count in filename
            const pageCount = st.pendingPages.length;
            const filename = pageCount > 1 ? `pages_${pageCount}_${Date.now()}.${ext}` : `page_${Date.now()}.${ext}`;
            
            // Send as photo for image formats, as document for PDF
            if (format === "pdf") {
                await bot.sendDocument(chatId, outFile, {}, { filename });
            } else {
                await bot.sendPhoto(chatId, outFile, { caption: `📄 ${format.toUpperCase()} file generated` });
            }

            // Physical Cleanup - Only clean known image files, avoid permission issues
            const allFiles = [...(st.fronts || []), ...(st.backs || [])];
            allFiles.forEach(f => {
                try { 
                    if (f.path && fs.existsSync(f.path)) {
                        fs.unlinkSync(f.path);
                    }
                } catch (e) {
                    // Ignore permission errors - files may be locked by system
                }
            });
            try { 
                if (outFile && fs.existsSync(outFile)) {
                    fs.unlinkSync(outFile);
                }
            } catch (e) {
                // Ignore permission errors
            }

            st.fronts = []; st.backs = []; st.imageGroups = [[]]; st.currentGroup = 0; st.pendingPages = null;
            st.pendingImages = []; st.lastStatusMsgId = null;
            persistState(chatId);

            await bot.sendMessage(chatId, `✅ Successfully Printed ${pageCount} page(s)!\nFiles and session data cleared. Starting fresh batch.`, { reply_markup: getMainKeyboard(chatId) });

        } catch (e) { await bot.sendMessage(chatId, "❌ Error: " + e.message); }
    }
}



async function renderSettings(chatId, messageId = null) {
    const st = getState(chatId);
    const s = st.settings;
    const l = s.layout;
    let text = `⚙️ **Layout Settings** (Auto-Saved)\n\n📍 Mode: ${s.mode.toUpperCase()}\n📏 Size: ${s.boxWidth} x ${s.boxHeight} ${s.unit}\n↔️ Gap (Sides): ${s.gap} (${Math.round(l.centerGap)}px)\n↕️ Gap (Down): Level ${s.vertGapChoice} (${Math.round(l.verticalGap)}px)\n↕️ Margin Top: ${s.topMargin}px\n📄 Format: ${s.outputFormat.toUpperCase()}\n\n`;
    if (!l.fitsA4) text += `⚠️ **ERROR**: ${l.error}\n`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "Mode: " + (s.mode === "default" ? "✅ Default" : "Custom"), callback_data: "set_mode" }],
            [{ text: "📐 Set Size (W * H)", callback_data: "set_size" }, { text: "↕️ Down Gap (1-4)", callback_data: "set_vgap" }],
            [{ text: "↔️ Side Gap", callback_data: "set_gap" }, { text: "↕️ Top Margin", callback_data: "toggle_margin" }],
            [{ text: "📄 Format", callback_data: "set_format" }, { text: "💾 Save current size", callback_data: "p_user_save" }],
            [{ text: "❌ Close Settings", callback_data: "close_settings" }]
        ]
    };

    if (messageId) {
        return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: keyboard }).catch(() => { });
    } else {
        return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
}

async function renderSizeMenu(chatId, messageId) {
    const st = getState(chatId);
    const inline_keyboard = presets.map(p => ([{
        text: `🌐 ${p.name} (${p.w}x${p.h} ${p.u})`,
        callback_data: `p_sel_${presets.indexOf(p)}`
    }]));

    if (st.userPresets && st.userPresets.length > 0) {
        st.userPresets.forEach((p, idx) => {
            inline_keyboard.push([
                { text: `${p.name} (${p.w}x${p.h}${p.u})`, callback_data: `p_user_sel_${idx}` },
                { text: "X", callback_data: `p_user_del_${idx}` }
            ]);
        });
    }
    inline_keyboard.push([{ text: "✏️ Custom Manual", callback_data: "set_size_custom" }]);
    inline_keyboard.push([{ text: "⬅️ Back", callback_data: "refresh_settings" }]);

    return bot.editMessageText("📐 **Choose ID Size**\nSelect a preset or enter manually:", {
        chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard }
    }).catch(() => { });
}

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    if (blacklistedChats.has(chatId)) return;
    registerChatId(msg);
    const msgId = msg.message_id;

    // Prevent double processing
    if (processedMessageIds.has(chatId + ":" + msgId)) return;
    processedMessageIds.add(chatId + ":" + msgId);

    const st = getState(chatId);

    // Broadcast Handling for Admin
    const caption = msg.caption || "";
    const isBroadcastTrigger = (msg.text && msg.text.toLowerCase().trim() === "/broadcast") || (caption.toLowerCase().trim() === "/broadcast");
    const isReplyBroadcast = msg.reply_to_message && msg.text && msg.text.toLowerCase().trim() === "/broadcast";

    if (ADMIN_ID && chatId === ADMIN_ID && (isBroadcastTrigger || isReplyBroadcast)) {
        const targetMsg = isReplyBroadcast ? msg.reply_to_message : msg;
        const userIds = Array.from(knownChats.keys());
        let sent = 0;

        // Handle Media Group (Album) Broadcast
        if (targetMsg.media_group_id) {
            // In a media group, we receive multiple messages. 
            // To "send as it", we should collect all parts first.
            if (!st.broadcastAlbumCache) st.broadcastAlbumCache = new Map();
            let cache = st.broadcastAlbumCache.get(targetMsg.media_group_id);
            if (!cache) {
                cache = { msgs: [], timer: null };
                st.broadcastAlbumCache.set(targetMsg.media_group_id, cache);
            }
            cache.msgs.push(targetMsg);

            if (cache.timer) clearTimeout(cache.timer);
            cache.timer = setTimeout(async () => {
                st.broadcastAlbumCache.delete(targetMsg.media_group_id);
                const media = cache.msgs.map(m => {
                    const type = m.photo ? 'photo' : (m.video ? 'video' : (m.audio ? 'audio' : 'document'));
                    const fileId = m.photo ? m.photo[m.photo.length - 1].file_id : (m.video ? m.video.file_id : (m.audio ? m.audio.file_id : m.document.file_id));
                    return { type, media: fileId, caption: m.caption };
                });

                for (const uId of userIds) {
                    if (ADMIN_ID && uId === ADMIN_ID) continue;
                    try {
                        await bot.sendMediaGroup(uId, media);
                        sent++;
                    } catch (e) { }
                }
                bot.sendMessage(chatId, `📢 Album broadcast complete. Sent to ${sent} users.`);
            }, 1500);
            return;
        }

        // Individual message broadcast
        for (const uId of userIds) {
            if (ADMIN_ID && uId === ADMIN_ID) continue;
            try {
                await bot.copyMessage(uId, chatId, targetMsg.message_id);
                sent++;
            } catch (e) { }
        }
        return bot.sendMessage(chatId, `📢 Broadcast complete. Sent to ${sent}/${userIds.length - 1} users.`);
    }




    const rawText = msg.text || "";
    const text = rawText.toLowerCase();

    // Basic command routing (unified for buttons and slash commands)
    const isCommand = text.startsWith("/") || ["🚀 start", "📋 status", "⚙️ settings", "🔄 reset", "⏭️ next id", "🛠️ admin", "📄 print", "print"].includes(text);
    if (isCommand) {
        const cmdName = text.startsWith("/") ? text.split(" ")[0] : text;
        return handleCommand(chatId, cmdName, msg);
    }


    if (st.awaitingSetting) {
        if (st.awaitingSetting === "broadcast_msg") {
            if (!st.broadcastQueue) st.broadcastQueue = [];
            st.broadcastQueue.push(msg.message_id);
            persistState(chatId);

            // Higher debounce (1.5s) to aggregate multi-image uploads safely
            if (st.broadcastUpdatePending) return;
            st.broadcastUpdatePending = true;

            setTimeout(async () => {
                st.broadcastUpdatePending = false;
                const count = st.broadcastQueue ? st.broadcastQueue.length : 0;
                const text = `✅ Message #${count} added to queue. Send more or click below:`;
                const kb = {
                    inline_keyboard: [[
                        { text: `🚀 Broadcast Now (${count})`, callback_data: "adm_broadcast_now" },
                        { text: "❌ Cancel", callback_data: "adm_broadcast_cancel" }
                    ]]
                };

                if (st.lastBroadcastConfirmId) {
                    try {
                        await bot.editMessageText(text, { chat_id: chatId, message_id: st.lastBroadcastConfirmId, reply_markup: kb });
                        return;
                    } catch (e) {
                        // If edit fails, try sending fresh
                    }
                }
                const m = await bot.sendMessage(chatId, text, { reply_markup: kb });
                st.lastBroadcastConfirmId = m.message_id;
            }, 1500);
            return;
        }





        const p = rawText.split(/[\s,*]+/);

        if (st.awaitingSetting === "save_user_preset") {
            const name = rawText.trim();
            const s = st.settings;
            if (!st.userPresets) st.userPresets = [];
            st.userPresets.push({ name, w: s.boxWidth, h: s.boxHeight, u: s.unit, gap: s.gap });
            st.awaitingSetting = null;
            persistState(chatId);
            return bot.sendMessage(chatId, `✅ Preset "${name}" saved!`, { reply_markup: getMainKeyboard(chatId) });
        } else if (st.awaitingSetting === "set_size") {
            const w = parseFloat(p[0]), h = parseFloat(p[1]), u = p[2] || "px";
            if (!isNaN(w) && !isNaN(h)) {
                st.settings.boxWidth = w; st.settings.boxHeight = h; st.settings.unit = u;
                st.settings.mode = "custom";
                st.settings.layout = calculateLayout(w, h, u, st.settings.gap, st.settings.topMargin, st.settings.topMarginUnit, st.settings.vertGapChoice);
                persistState(chatId);
                await bot.sendMessage(chatId, `✅ Size updated to ${w} x ${h} ${u}. Check /settings for layout validity.`);
            } else {
                await bot.sendMessage(chatId, "❌ Invalid format. Use: `Width * Height Unit`", { parse_mode: "Markdown" });
            }
        }
        st.awaitingSetting = null;
        return;
    }


    if (text === "front") {
        const img = await takePendingImage(st);
        if (!img) return bot.sendMessage(chatId, "❌ No image found to label as front. Send an image first.");
        addLabeledImage(st, "front", img.path, img.seq);
        persistState(chatId);
        return sendCounterMsgCustom(chatId);
    } else if (text === "back") {
        const img = await takePendingImage(st);
        if (!img) return bot.sendMessage(chatId, "❌ No image found to label as back. Send an image first.");
        addLabeledImage(st, "back", img.path, img.seq);
        persistState(chatId);
        return sendCounterMsgCustom(chatId);
    }
});

async function deleteOldStatus(chatId) {
    const st = getState(chatId);
    if (st.lastStatusMsgId) {
        try { await bot.deleteMessage(chatId, st.lastStatusMsgId); } catch (e) { }
        st.lastStatusMsgId = null;
    }
}




bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    if (blacklistedChats.has(chatId)) return;
    const st = getState(chatId);
    if (st.awaitingSetting === "broadcast_msg") return; // Let message handler handle broadcast


    // Don't delete status message - we'll update it in place
    registerChatId(msg);
    const best = msg.photo[msg.photo.length - 1];
    const userDir = path.join(ROOT, String(chatId));
    ensureDir(userDir);
    const imgPath = path.join(userDir, `u_${Date.now()}_${uuidv4()}.jpg`);
    const downloadPromise = downloadTelegramFile(best.file_id, imgPath);
    const caption = (msg.caption || "").toLowerCase();

    if (!caption.includes("front") && !caption.includes("back")) queuePendingImage(st, imgPath, msg.message_id, downloadPromise);
    await downloadPromise;

    // Handle Media Groups (Albums)
    if (msg.media_group_id) {
        if (!st.mediaGroupCache) st.mediaGroupCache = new Map();
        let cache = st.mediaGroupCache.get(msg.media_group_id);
        if (!cache) {
            cache = { id: msg.media_group_id, items: [], timer: null };
            st.mediaGroupCache.set(msg.media_group_id, cache);
        }
        cache.items.push({ path: imgPath, msgId: msg.message_id });

        if (cache.timer) clearTimeout(cache.timer);
        cache.timer = setTimeout(async () => {
            st.mediaGroupCache.delete(msg.media_group_id);
            if (cache.items.length === 2 && !caption.includes("front") && !caption.includes("back")) {
                // Auto-label pair
                const item1 = cache.items[0];
                const item2 = cache.items[1];

                // Remove from pending
                st.pendingImages = st.pendingImages.filter(p => p.path !== item1.path && p.path !== item2.path);

                addLabeledImage(st, "front", item1.path, item1.msgId);
                addLabeledImage(st, "back", item2.path, item2.msgId);
                persistState(chatId);

                // Update status instead of sending separate message
                return sendCounterMsgCustom(chatId);
            }
        }, 1500);
        return;
    }

    if (caption.includes("front")) {

        addLabeledImage(st, "front", imgPath, msg.message_id);
        persistState(chatId);
        await sendCounterMsgCustom(chatId);
    } else if (caption.includes("back")) {
        addLabeledImage(st, "back", imgPath, msg.message_id);
        persistState(chatId);
        await sendCounterMsgCustom(chatId);
    } else {
        // Update status instead of sending separate message
        await sendCounterMsgCustom(chatId);
    }
});

async function sendCounterMsgCustom(chatId) {
    const st = getState(chatId);
    const { pages, totalPairs, totalPages } = buildPairsFromGroups(st.imageGroups);
    const currentIdx = st.currentGroup || 0;
    const currentGroup = st.imageGroups[currentIdx] || [];
    const hasFront = currentGroup.some(img => img.type === "front");
    const hasBack = currentGroup.some(img => img.type === "back");

    // Simple status text
    let text = `📊 Ready Pairs: ${totalPairs}\n`;
    text += `✅Front: ${currentGroup.filter(img => img.type === "front").length}\n`;
    text += `✅Back: ${currentGroup.filter(img => img.type === "back").length}\n`;
    
    if (totalPages > 1) {
        text += `Pages: ${totalPages} (auto-distributed)\n`;
    }
    
    text += `💡 Actions: /print • /reset • /next`;

    // Update existing message or create new one
    if (st.lastStatusMsgId) {
        try {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: st.lastStatusMsgId,
                reply_markup: getMainKeyboard(chatId)
            });
            return;
        } catch (e) {
            // Create new message if edit fails
            st.lastStatusMsgId = null;
        }
    }

    // Create new status message
    const m = await bot.sendMessage(chatId, text, { 
        reply_markup: getMainKeyboard(chatId) 
    });
    st.lastStatusMsgId = m.message_id;
}


bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    if (blacklistedChats.has(chatId)) return;
    registerChatId(msg);
    const st = getState(chatId);
    if (st.awaitingSetting === "broadcast_msg") return; // Let message handler handle broadcast


    // Don't delete status message - we'll update it in place
    registerChatId(chatId);
    const doc = msg.document;
    if (!doc?.file_id) return;
    const filename = (doc.file_name || "").toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].some(e => filename.endsWith(e))) return;
    const userDir = path.join(ROOT, String(chatId));
    ensureDir(userDir);
    const pathOut = path.join(userDir, `d_${Date.now()}_${filename}`);
    const downloadPromise = downloadTelegramFile(doc.file_id, pathOut);
    const caption = (msg.caption || "").toLowerCase();

    if (!caption.includes("front") && !caption.includes("back")) queuePendingImage(st, pathOut, msg.message_id, downloadPromise);
    await downloadPromise;

    if (caption.includes("front")) {
        addLabeledImage(st, "front", pathOut, msg.message_id);
        persistState(chatId);
        await sendCounterMsgCustom(chatId);
    } else if (caption.includes("back")) {
        addLabeledImage(st, "back", pathOut, msg.message_id);
        persistState(chatId);
        await sendCounterMsgCustom(chatId);
    } else {
        // Update status instead of sending separate message
        await sendCounterMsgCustom(chatId);
    }
});

console.log("✅ Bot is running...");
