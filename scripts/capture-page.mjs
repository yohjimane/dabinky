import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, rmSync } from 'fs';
import path from 'path';

const URL = process.argv[2] || 'http://localhost:3001/?capture=true';
const FPS = parseInt(process.argv[3] || '60');
const DURATION = parseFloat(process.argv[4] || '12');
const WIDTH = parseInt(process.argv[5] || '1920');
const HEIGHT = parseInt(process.argv[6] || '1080');
const OUTPUT = process.argv[7] || 'public/captures/hero.mov';

const TOTAL_FRAMES = Math.ceil(FPS * DURATION);
const FRAME_DIR = path.resolve('.frames-tmp');

const VIRTUAL_TIME_SCRIPT = `
(() => {
    let virtualNow = 0;
    const FRAME_MS = ${1000 / FPS};

    performance.now = () => virtualNow;
    Date.now = () => virtualNow;

    const rafQueue = [];
    let rafId = 0;
    window.requestAnimationFrame = (cb) => {
        const id = ++rafId;
        rafQueue.push({ id, cb });
        return id;
    };
    window.cancelAnimationFrame = (id) => {
        const idx = rafQueue.findIndex(r => r.id === id);
        if (idx !== -1) rafQueue.splice(idx, 1);
    };

    const timers = [];
    let timerId = 1000;

    window.setTimeout = (cb, ms = 0, ...args) => {
        const id = ++timerId;
        timers.push({ id, cb, args, fireAt: virtualNow + ms, interval: false });
        return id;
    };
    window.setInterval = (cb, ms = 0, ...args) => {
        const id = ++timerId;
        timers.push({ id, cb, args, fireAt: virtualNow + ms, interval: true, ms });
        return id;
    };
    window.clearTimeout = (id) => {
        const idx = timers.findIndex(t => t.id === id);
        if (idx !== -1) timers.splice(idx, 1);
    };
    window.clearInterval = window.clearTimeout;

    window.__stepTime = () => {
        virtualNow += FRAME_MS;

        const due = timers.filter(t => t.fireAt <= virtualNow);
        for (const t of due) {
            t.cb(...t.args);
            if (t.interval) {
                t.fireAt += t.ms;
            } else {
                const idx = timers.indexOf(t);
                if (idx !== -1) timers.splice(idx, 1);
            }
        }

        const batch = rafQueue.splice(0);
        for (const { cb } of batch) {
            try { cb(virtualNow); } catch {}
        }
    };

    window.__virtualNow = () => virtualNow;
})();
`;

async function main() {
    if (existsSync(FRAME_DIR)) rmSync(FRAME_DIR, { recursive: true });
    mkdirSync(FRAME_DIR, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.addInitScript(VIRTUAL_TIME_SCRIPT);
    await page.goto(URL, { waitUntil: 'networkidle' });

    for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.__stepTime());
    }

    console.log(`Capturing ${TOTAL_FRAMES} frames at ${WIDTH}x${HEIGHT} @ ${FPS}fps...`);

    for (let i = 0; i < TOTAL_FRAMES; i++) {
        await page.evaluate(() => window.__stepTime());
        await page.evaluate(() => window.__capture?.stepFrame());

        const padded = String(i).padStart(5, '0');
        await page.screenshot({ path: `${FRAME_DIR}/frame_${padded}.png` });

        if (i % 60 === 0) console.log(`  frame ${i}/${TOTAL_FRAMES}`);
    }

    await browser.close();

    const outputDir = path.dirname(path.resolve(OUTPUT));
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    console.log(`Encoding to ${OUTPUT}...`);
    execSync(
        `ffmpeg -y -framerate ${FPS} -i "${FRAME_DIR}/frame_%05d.png" -c:v prores_ks -profile:v 3 -pix_fmt yuva444p10le "${path.resolve(OUTPUT)}"`,
        { stdio: 'inherit' }
    );

    rmSync(FRAME_DIR, { recursive: true });
    console.log('Done!');
}

main().catch(console.error);
