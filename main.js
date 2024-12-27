const isDev = require("electron-is-dev");
const path = require("path");
const url = require("url");

const checkForUpdatesAndNotify = require("./src/node/updates.js");
require('./src/server/index.js'); // Start the Express server

const {
  app,
  protocol,
  screen,
  ipcMain,
  shell,
  BrowserWindow,
  components
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
      contextIsolation: true,
      preload: path.join(__dirname, "src/preload/index.js"),
      webSecurity: false,
      plugins: true // Enable plugins for Widevine
    },
  });

  // Set window to ignore mouse events by default
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  ipcMain.on("minimize", () => mainWindow.minimize());
  ipcMain.on("close", () => mainWindow.close());
  ipcMain.on("setThumbnailClip", (_, clip) => mainWindow.setThumbnailClip(clip));
  ipcMain.handle("getBounds", () => mainWindow.getBounds());
  ipcMain.handle("getCursorScreenPoint", () => screen.getCursorScreenPoint());
  
  // Modify the ignoreMouseEvents handler to be more precise
  ipcMain.on("ignoreMouseEvents", (_, ignore, options = {}) => {
    if (ignore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
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
  app.whenReady().then(async () => {
    await components.whenReady();
    console.log('Components ready:', components.status());
    setTimeout(createWindow, 100);
  });
} else {
  app.whenReady().then(async () => {
    await components.whenReady();
    console.log('Components ready:', components.status());
    createWindow();
  });
}

// Add new IPC handlers for Spotify authentication
ipcMain.on("initiate-spotify-auth", () => {
  let authWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "src/preload/auth-preload.js")
    }
  });

  authWindow.loadURL('http://localhost:3000/login');

  // Handle window close
  authWindow.on('closed', () => {
    authWindow = null;
  });

  // Listen for the success URL
  authWindow.webContents.on('did-navigate', (event, url) => {
    if (url.startsWith('http://localhost:3000/callback')) {
      // Send success message to main window
      mainWindow.webContents.send('spotify-auth-success');
      // Close auth window after a short delay
      setTimeout(() => {
        if (authWindow) {
          authWindow.close();
          authWindow = null;
        }
      }, 1000);
    }
  });
});

app.on("web-contents-created", (event, contents) => {
  // Prevent all navigation for security reasons except for Spotify auth
  contents.on("will-navigate", (event, navigationUrl) => {
    const parsedUrl = url.parse(navigationUrl);
    if (!parsedUrl.hostname.includes('spotify.com') && !parsedUrl.hostname.includes('localhost')) {
      event.preventDefault();
    }
  });
  
  // Allow new windows for Spotify auth, otherwise open in default browser
  contents.on("new-window", (event, navigationUrl) => {
    const parsedUrl = url.parse(navigationUrl);

    if (parsedUrl.protocol === "chrome-devtools:") {
      return;
    }

    if (parsedUrl.hostname.includes('spotify.com') || parsedUrl.hostname.includes('localhost')) {
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
