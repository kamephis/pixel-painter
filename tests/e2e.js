/*
 * End-to-End-Tests für Pixel Painter (index.html).
 *
 * Voraussetzungen: Node + Playwright + Chromium.
 *   npm i -g playwright   (oder lokal)  und ein Chromium, das Playwright findet.
 * Ausführen:
 *   NODE_PATH=$(npm root -g) node tests/e2e.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpainter-e2e-'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());

  // ---- Fixture: 128×96-Spritesheet mit 32px-Kacheln erzeugen ----
  await page.goto('about:blank');
  const sheetDataURL = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 96;
    const x = c.getContext('2d');
    const cols = ['#e04040', '#40b040', '#4060e0', '#e0c040', '#a040c0', '#40c0c0'];
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 4; tx++) {
        x.fillStyle = cols[(ty * 4 + tx) % cols.length];
        x.fillRect(tx * 32, ty * 32, 32, 32);
        x.clearRect(tx * 32 + 12, ty * 32 + 12, 8, 8); // Loch für Transparenz-Checks
      }
    }
    return c.toDataURL('image/png');
  });
  const sheetPath = path.join(tmp, 'tiles.png');
  fs.writeFileSync(sheetPath, Buffer.from(sheetDataURL.split(',')[1], 'base64'));

  await page.goto(APP);
  await page.waitForTimeout(400);

  const results = [];
  const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  [' + extra + ']' : ''}`);

  async function clickDoc(x, y) {
    const p = await page.evaluate(([x, y]) => window.__pw.docToScreen(x + 0.5, y + 0.5), [x, y]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
  }
  async function dragDoc(x0, y0, x1, y1) {
    const a = await page.evaluate(([x, y]) => window.__pw.docToScreen(x + 0.5, y + 0.5), [x0, y0]);
    const b = await page.evaluate(([x, y]) => window.__pw.docToScreen(x + 0.5, y + 0.5), [x1, y1]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.mouse.up();
  }

  /* ---------- Grundfunktionen ---------- */
  check('app loaded', await page.evaluate(() => !!window.__pw && !!window.__pw.getDoc()));

  await clickDoc(5, 5);
  let px = await page.evaluate(() => window.__pw.getPixel(5, 5));
  check('pencil single click', px.join() === '0,0,0,255', px.join());
  await dragDoc(10, 10, 20, 10);
  px = await page.evaluate(() => window.__pw.getPixel(15, 10));
  check('pencil drag line', px[3] === 255, px.join());

  await page.click('#btnUndo');
  px = await page.evaluate(() => window.__pw.getPixel(15, 10));
  check('undo stroke', px[3] === 0, px.join());
  await page.click('#btnRedo');
  px = await page.evaluate(() => window.__pw.getPixel(15, 10));
  check('redo stroke', px[3] === 255, px.join());

  await page.evaluate(() => { window.__pw.state.fg = { r: 255, g: 0, b: 0, a: 255 }; window.__pw.setTool('fill'); });
  await clickDoc(40, 40);
  px = await page.evaluate(() => window.__pw.getPixel(40, 40));
  check('flood fill red', px.join() === '255,0,0,255', px.join());
  px = await page.evaluate(() => window.__pw.getPixel(15, 10));
  check('fill keeps drawn pixels', px.join() === '0,0,0,255', px.join());

  await page.evaluate(() => window.__pw.setTool('eraser'));
  await clickDoc(40, 40);
  px = await page.evaluate(() => window.__pw.getPixel(40, 40));
  check('eraser clears', px[3] === 0, px.join());

  await page.evaluate(() => { window.__pw.setTool('rect'); window.__pw.state.shapeFill = true; window.__pw.state.fg = { r: 0, g: 200, b: 0, a: 255 }; });
  await dragDoc(2, 30, 10, 38);
  px = await page.evaluate(() => window.__pw.getPixel(6, 34));
  check('filled rect', px.join() === '0,200,0,255', px.join());

  await page.evaluate(() => { window.__pw.setTool('ellipse'); window.__pw.state.shapeFill = false; window.__pw.state.fg = { r: 0, g: 0, b: 255, a: 255 }; });
  await dragDoc(24, 24, 44, 44);
  // Rand blau, Zentrum bleibt unverändert (rot vom Fill davor) -> echter Umriss
  const ell = await page.evaluate(() => [window.__pw.getPixel(34, 24), window.__pw.getPixel(34, 34)]);
  check('ellipse outline (edge blue, center untouched)', ell[0].join() === '0,0,255,255' && ell[1].join() === '255,0,0,255', JSON.stringify(ell));

  /* ---------- Vorlage, Ebenen, Frames ---------- */
  await page.click('#btnNew');
  await page.selectOption('#selTemplate', '4'); // RPG Maker MZ/MV Charakter 144×192
  await page.click('#btnNewOk');
  await page.waitForTimeout(200);
  const dims = await page.evaluate(() => { const d = window.__pw.getDoc(); return [d.w, d.h, d.tileW].join(); });
  check('template new doc 144x192 tile48', dims === '144,192,48', dims);

  await page.click('#btnLayerAdd');
  check('add layer', await page.evaluate(() => window.__pw.getDoc().layers.length) === 2);

  await page.click('#btnFrameAdd');
  const frameInfo = await page.evaluate(() => {
    const d = window.__pw.getDoc();
    return { frames: d.frames.length, cels: d.layers.map(l => l.cels.length).join(), active: window.__pw.state.activeFrame };
  });
  check('add frame syncs cels', frameInfo.frames === 2 && frameInfo.cels === '2,2' && frameInfo.active === 1, JSON.stringify(frameInfo));

  /* ---------- Sprite-Brush-Workflow ---------- */
  await page.setInputFiles('#fileAsset', sheetPath);
  await page.waitForTimeout(500);
  const assetInfo = await page.evaluate(() => window.__pw.state.assets.map(a => ({ w: a.img.width, h: a.img.height, t: a.tileW, s: a.scale })));
  check('asset loaded, tile guessed 32, zoom default 150%', assetInfo.length === 1 && assetInfo[0].t === 32 && assetInfo[0].s === 1.5, JSON.stringify(assetInfo));

  const aview = page.locator('.assetcard canvas.aview');
  await aview.scrollIntoViewIfNeeded();
  const av = await aview.boundingBox();
  const a0 = assetInfo[0];
  await page.mouse.move(av.x + (a0.t + a0.t / 2) * a0.s, av.y + (a0.t + a0.t / 2) * a0.s);
  await page.mouse.down();
  await page.mouse.up();
  const stampInfo = await page.evaluate(() => {
    const s = window.__pw.state;
    return s.stamp ? { w: s.stamp.canvas.width, h: s.stamp.canvas.height, tool: s.tool } : null;
  });
  check('tile click -> stamp brush + tool', !!stampInfo && stampInfo.w === 32 && stampInfo.h === 32 && stampInfo.tool === 'stamp', JSON.stringify(stampInfo));

  await clickDoc(60, 60); // Snap an -> Zelle (48,48)
  const stampResult = await page.evaluate(() => {
    const d = window.__pw.getDoc();
    const s = window.__pw.state;
    const cel = d.layers[s.activeLayer].cels[s.activeFrame];
    const st = s.stamp.canvas;
    const img = cel.getContext('2d').getImageData(48, 48, st.width, st.height).data;
    let n = 0; for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    const src = st.getContext('2d').getImageData(0, 0, st.width, st.height).data;
    let m = 0; for (let i = 3; i < src.length; i += 4) if (src[i] > 0) m++;
    const out = cel.getContext('2d').getImageData(0, 0, 48, 48).data;
    let o = 0; for (let i = 3; i < out.length; i += 4) if (out[i] > 0) o++;
    return { n, m, o };
  });
  check('stamp placed at snapped cell', stampResult.n === stampResult.m && stampResult.m > 0 && stampResult.o === 0, JSON.stringify(stampResult));

  // Sprite-Karte einklappen/ausklappen (Klick auf den Kartenkopf)
  await page.click('.assetcard .aname');
  check('asset card collapses', await page.evaluate(() =>
    document.querySelector('.assetcard').classList.contains('collapsed') &&
    document.querySelector('.assetcard .aviewwrap').offsetParent === null));
  await page.click('.assetcard .aname');
  check('asset card expands', await page.evaluate(() =>
    !document.querySelector('.assetcard').classList.contains('collapsed') &&
    document.querySelector('.assetcard .aviewwrap').offsetParent !== null));

  /* ---------- Hilfslinien & Auswahl ---------- */
  const rt = await page.locator('#rulerTop').boundingBox();
  await page.mouse.move(rt.x + 400, rt.y + rt.height / 2);
  await page.mouse.down();
  const gp = await page.evaluate(() => window.__pw.docToScreen(0, 50));
  await page.mouse.move(gp.x + 200, gp.y, { steps: 5 });
  await page.mouse.up();
  const guides = await page.evaluate(() => window.__pw.state.guides);
  check('guide from ruler, snapped to 48', guides.length === 1 && guides[0].axis === 'h' && guides[0].pos === 48, JSON.stringify(guides));

  await page.evaluate(() => window.__pw.setTool('select'));
  await dragDoc(50, 50, 70, 70);
  const sel = await page.evaluate(() => window.__pw.state.selection);
  check('selection snapped to tiles', !!sel && sel.x === 48 && sel.y === 48 && sel.w === 48 && sel.h === 48, JSON.stringify(sel));
  await page.keyboard.press('Control+D');

  /* ---------- Spiegeln, Auswahl-Klipping, Verschieben ---------- */
  await page.evaluate(() => {
    window.__pw.setTool('pencil');
    window.__pw.state.mirrorX = true;
    window.__pw.state.fg = { r: 10, g: 20, b: 30, a: 255 };
  });
  await clickDoc(4, 100);
  const both = await page.evaluate(() => [window.__pw.getPixel(4, 100), window.__pw.getPixel(139, 100)]);
  check('mirror X paints both sides', both[0][3] === 255 && both[1][3] === 255, JSON.stringify(both));
  await page.evaluate(() => { window.__pw.state.mirrorX = false; });

  await page.evaluate(() => { window.__pw.state.snap = false; window.__pw.setTool('select'); });
  await dragDoc(2, 98, 6, 102);
  const sel2 = await page.evaluate(() => window.__pw.state.selection);
  check('free selection exact pixels', sel2 && sel2.x === 2 && sel2.y === 98 && sel2.w === 5 && sel2.h === 5, JSON.stringify(sel2));
  await page.keyboard.press('Delete');
  const delPx = await page.evaluate(() => [window.__pw.getPixel(4, 100), window.__pw.getPixel(139, 100)]);
  check('delete clears only selection', delPx[0][3] === 0 && delPx[1][3] === 255, JSON.stringify(delPx));

  await page.evaluate(() => window.__pw.setTool('pencil'));
  await clickDoc(20, 120);
  const clipped = await page.evaluate(() => window.__pw.getPixel(20, 120));
  check('pencil clipped to selection', clipped[3] === 0, clipped.join());
  await page.keyboard.press('Control+D');

  await clickDoc(30, 130);
  await page.evaluate(() => {
    window.__pw.state.selection = { x: 30, y: 130, w: 1, h: 1 };
    window.__pw.setTool('move');
  });
  await dragDoc(30, 130, 35, 133);
  const moved = await page.evaluate(() => [window.__pw.getPixel(30, 130), window.__pw.getPixel(35, 133), window.__pw.state.selection]);
  check('move selection content', moved[0][3] === 0 && moved[1][3] === 255 && moved[2].x === 35 && moved[2].y === 133, JSON.stringify(moved));
  await page.keyboard.press('Control+D');
  await page.keyboard.press('Control+Z');
  const undone = await page.evaluate(() => [window.__pw.getPixel(30, 130), window.__pw.getPixel(35, 133)]);
  check('undo move', undone[0][3] === 255 && undone[1][3] === 0, JSON.stringify(undone));
  await page.evaluate(() => { window.__pw.state.snap = true; });

  /* ---------- Playback ---------- */
  await page.click('#btnFrameAdd');
  await page.evaluate(() => { window.__pw.getDoc().frames.forEach(f => f.duration = 60); window.__pw.state.activeFrame = 0; });
  await page.click('#btnPlay');
  const playing = await page.evaluate(() => window.__pw.state.playing);
  const seenFrames = new Set();
  for (let i = 0; i < 10; i++) {
    seenFrames.add(await page.evaluate(() => window.__pw.state.activeFrame));
    await page.waitForTimeout(45);
  }
  await page.click('#btnPlay');
  check('playback advances frames', playing && seenFrames.size >= 3, 'frames seen: ' + [...seenFrames].join(','));
  check('playback stops', await page.evaluate(() => window.__pw.state.playing) === false);
  await page.evaluate(() => { window.__pw.state.activeFrame = 1; });

  /* ---------- Speichern, Export, Wiederherstellen ---------- */
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSaveProj')]);
  const projPath = path.join(tmp, 'projekt.pixelpainter.json');
  await dl.saveAs(projPath);
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  check('project json complete',
    proj.app === 'pixelpainter' && proj.layers.length === 2 && proj.layers[0].cels.length === 3 &&
    proj.assets.length === 1 && proj.assets[0].scale === 1.5 && proj.assets[0].collapsed === false &&
    proj.guides.length === 1 && proj.width === 144,
    `layers=${proj.layers.length} cels=${proj.layers[0].cels.length} assets=${proj.assets.length} guides=${proj.guides.length}`);

  await page.click('#btnExportPng');
  await page.check('input[name=expScope][value=sheet]');
  await page.fill('#inpExpCols', '3');
  await page.selectOption('#selExpScale', '2');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btnExpOk')]);
  const pngPath = path.join(tmp, 'export.png');
  await dl2.saveAs(pngPath);
  const buf = fs.readFileSync(pngPath);
  const sigOk = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20);
  check('png spritesheet export 3 cols 2x (864x384)', sigOk && pw === 864 && ph === 384, `${pw}x${ph}`);

  await page.reload();
  await page.waitForTimeout(400);
  await page.setInputFiles('#fileProj', projPath);
  await page.waitForTimeout(800);
  const loaded = await page.evaluate(() => {
    const d = window.__pw.getDoc();
    const s = window.__pw.state;
    return { w: d.w, h: d.h, layers: d.layers.length, frames: d.frames.length, assets: s.assets.length, guides: s.guides.length };
  });
  check('project reload restores all', loaded.w === 144 && loaded.h === 192 && loaded.layers === 2 && loaded.frames === 3 && loaded.assets === 1 && loaded.guides === 1, JSON.stringify(loaded));
  const n2 = await page.evaluate(() => {
    const d = window.__pw.getDoc();
    const img = d.layers[0].cels[1].getContext('2d').getImageData(48, 48, 32, 32).data;
    let n = 0; for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    return n;
  });
  check('stamped pixels persisted through save/load', n2 > 0, 'n=' + n2);

  /* ---------- Panel-Layout & Ansicht ---------- */
  // Einklappen per Klick auf den Panel-Kopf
  await page.click('.panel[data-panel="colors"] .phead');
  check('panel collapse on header click', await page.evaluate(() =>
    document.querySelector('.panel[data-panel="colors"]').classList.contains('collapsed') &&
    document.querySelector('.panel[data-panel="colors"] .pbody').offsetParent === null));
  await page.click('.panel[data-panel="colors"] .phead');
  check('panel expand on second click', await page.evaluate(() =>
    !document.querySelector('.panel[data-panel="colors"]').classList.contains('collapsed')));

  // Neu anordnen: „Ebenen“ über „Farben“ ziehen
  const lh = await page.locator('.panel[data-panel="layers"] .phead').boundingBox();
  const chp = await page.locator('.panel[data-panel="colors"] .phead').boundingBox();
  await page.mouse.move(lh.x + lh.width / 2, lh.y + lh.height / 2);
  await page.mouse.down();
  await page.mouse.move(chp.x + chp.width / 2, chp.y + 2, { steps: 6 });
  await page.mouse.up();
  const order = await page.evaluate(() => window.__pw.getUiState().order.join(','));
  check('panel reorder by drag (layers first)', order.startsWith('layers,colors'), order);

  // Sidebar-Breite per Splitter ändern
  const sw0 = await page.evaluate(() => document.querySelector('#sidebar').getBoundingClientRect().width);
  const spb = await page.locator('#sbSplitter').boundingBox();
  await page.mouse.move(spb.x + 2, spb.y + 200);
  await page.mouse.down();
  await page.mouse.move(spb.x + 2 - 120, spb.y + 200, { steps: 5 });
  await page.mouse.up();
  const sw1 = await page.evaluate(() => document.querySelector('#sidebar').getBoundingClientRect().width);
  check('sidebar width resizable', Math.abs(sw1 - (sw0 + 120)) <= 3, `${sw0} -> ${sw1}`);

  // Panel abdocken, Fenster verschieben, wieder andocken
  await page.click('.panel[data-panel="brushes"] .pfloat');
  check('panel undocks to floating window', await page.evaluate(() => !!document.querySelector('.floatwin[data-panel="brushes"]')));
  const fw = await page.locator('.floatwin[data-panel="brushes"]').boundingBox();
  const fh = await page.locator('.floatwin[data-panel="brushes"] .phead').boundingBox();
  await page.mouse.move(fh.x + 60, fh.y + fh.height / 2);
  await page.mouse.down();
  await page.mouse.move(fh.x + 60 + 90, fh.y + fh.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  const fw2 = await page.locator('.floatwin[data-panel="brushes"]').boundingBox();
  check('floating window movable', Math.abs(fw2.x - (fw.x + 90)) <= 3 && Math.abs(fw2.y - (fw.y + 60)) <= 3,
    `dx=${Math.round(fw2.x - fw.x)} dy=${Math.round(fw2.y - fw.y)}`);
  // Fenster in die Ecke schieben, damit die Leinwand frei ist – Zeichnen muss weiter funktionieren
  await page.evaluate(() => {
    const w = document.querySelector('.floatwin[data-panel="brushes"]');
    w.style.left = (document.querySelector('#main').clientWidth - w.offsetWidth - 8) + 'px';
    w.style.top = '8px';
  });
  await page.evaluate(() => { window.__pw.setTool('pencil'); window.__pw.state.fg = { r: 1, g: 2, b: 3, a: 255 }; });
  await clickDoc(3, 3);
  check('drawing works while panel floats', (await page.evaluate(() => window.__pw.getPixel(3, 3))).join() === '1,2,3,255');
  await page.click('.floatwin[data-panel="brushes"] .pfloat');
  check('panel docks back into sidebar', await page.evaluate(() =>
    !document.querySelector('.floatwin') && !!document.querySelector('#sidebar .panel[data-panel="brushes"]')));

  // 1:1-Lupe über Kacheln
  await page.click('#tgTileZoom');
  const aview2 = page.locator('.assetcard canvas.aview');
  await aview2.scrollIntoViewIfNeeded();
  const avb = await aview2.boundingBox();
  await page.mouse.move(avb.x + 10, avb.y + 10);
  await page.waitForTimeout(120);
  const mag = await page.evaluate(() => {
    const m = document.querySelector('#magnifier');
    const c = m.querySelector('canvas');
    return { hidden: m.classList.contains('hidden'), w: c.width, h: c.height, cap: m.querySelector('.magcap').textContent };
  });
  check('tile magnifier shows 1:1 (32x32)', !mag.hidden && mag.w === 32 && mag.h === 32, JSON.stringify(mag));
  await page.mouse.move(avb.x - 40, avb.y - 40);
  await page.waitForTimeout(120);
  check('magnifier hides on leave', await page.evaluate(() => document.querySelector('#magnifier').classList.contains('hidden')));
  await page.click('#tgTileZoom');

  // Vollbildmodus
  await page.click('#btnFullscreen');
  await page.waitForTimeout(250);
  const fsOn = await page.evaluate(() => !!document.fullscreenElement);
  await page.click('#btnFullscreen');
  await page.waitForTimeout(250);
  const fsOff = await page.evaluate(() => !document.fullscreenElement);
  check('fullscreen toggle', fsOn && fsOff, `on=${fsOn} off=${fsOff}`);

  // Layout-Persistenz über Reload (localStorage)
  await page.waitForTimeout(300); // saveUiState ist gedrosselt
  await page.reload();
  await page.waitForTimeout(400);
  const persisted = await page.evaluate(() => ({
    order0: window.__pw.getUiState().order[0],
    sw: Math.round(document.querySelector('#sidebar').getBoundingClientRect().width),
  }));
  check('ui layout persisted after reload', persisted.order0 === 'layers' && Math.abs(persisted.sw - sw1) <= 3, JSON.stringify(persisted) + ' erwartet sw=' + Math.round(sw1));

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log(`\n${results.length - fails.length}/${results.length} PASS`);
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
