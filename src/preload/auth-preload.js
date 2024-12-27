const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('authHandler', {
  authSuccess: () => {
    // This is just a placeholder since we're handling auth in the main process
    console.log('Auth success handled by main process');
  }
}); 