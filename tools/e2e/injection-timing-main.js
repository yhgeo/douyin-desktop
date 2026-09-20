// Loads tools/e2e/injection-timing-preload.js against a douyin.com origin and
// prints the timing report.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const harness = require('./harness');

const PORT = 45995;

harness.applyHarnessSwitches(PORT);

app.whenReady().then(async () => {
  const server = await harness.serveDouyinPage(PORT, harness.PAGE_WITH_SCRIPTS);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'injection-timing-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadURL('http://www.douyin.com/');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const report = await win.webContents.executeJavaScript('JSON.stringify(globalThis.__injectionTimingReport())');
  process.stdout.write(`INJECTION_TIMING=${report}\n`);

  server.close();
  app.quit();
});

app.on('window-all-closed', () => {});
