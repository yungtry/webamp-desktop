const isDev = require("electron-is-dev");
const path = require("path");
const url = require("url");

const checkForUpdatesAndNotify = require("./src/node/updates.js");

const {
  app,
  protocol,
  screen,
  ipcMain,
  shell,
  BrowserWindow,
} = require("electron");

if (isDev) {
  require("electron-debug")({ devToolsMode: "detach" });
}

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // Create the browser window.
  mainWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: width,
    height: height,
    transparent: true,
    frame: false,
    hasShadow: false,
    show: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    icon: path.join(__dirname, "res/icon.png"),
    webPreferences: {
      nodeIntegration: false,
      preload: path.join(__dirname, "src/preload/index.js"),
      webSecurity: false,
    },
  });

  ipcMain.on("minimize", () => mainWindow.minimize());
  ipcMain.on("close", () => mainWindow.close());
  ipcMain.on("setThumbnailClip", (_, clip) => mainWindow.setThumbnailClip(clip));
  ipcMain.handle("getBounds", () => mainWindow.getBounds());
  ipcMain.handle("getCursorScreenPoint", () => screen.getCursorScreenPoint());
  ipcMain.on("ignoreMouseEvents", (_, ignore) => {
    if (ignore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true })
    } else {
      mainWindow.setIgnoreMouseEvents(false)
    }
  });
  mainWindow.on('minimize', () => ipcMain.emit('minimized'));
  mainWindow.on('restore', () => ipcMain.emit('restored'));
  mainWindow.on('closed', () => ipcMain.emit('closed'));

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));

  // and show window once it's ready (to prevent flashing)
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    checkForUpdatesAndNotify();
  });

  mainWindow.on("closed", function () {
    // Dereference the window object
    mainWindow = null;
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// Linux has transparency disabled and window creation delayed
// due to issues with transparency of Chromium on Linux.
// See https://bugs.chromium.org/p/chromium/issues/detail?id=854601#c7
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.on("ready", () => setTimeout(createWindow, 100));
} else {
  app.on("ready", createWindow);
}

app.on("web-contents-created", (event, contents) => {
  // Prevent all navigation for security reasons
  // See https://github.com/electron/electron/blob/master/docs/tutorial/security.md#13-disable-or-limit-navigation
  contents.on("will-navigate", (event, navigationUrl) => {
    event.preventDefault();
  });
  // Prevent new window creation for security reasons
  // and open the URLs in the default browser instead
  // See https://github.com/electron/electron/blob/master/docs/tutorial/security.md#14-disable-or-limit-creation-of-new-windows
  contents.on("new-window", (event, navigationUrl) => {
    const parsedUrl = url.parse(navigationUrl);

    if (parsedUrl.protocol === "chrome-devtools:") {
      return;
    }

    event.preventDefault();
    shell.openExternal(navigationUrl);
  });
});

// Quit when all windows are closed.
app.on("window-all-closed", function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  }
});
