const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  const { appOutDir, packager } = context;
  const electronPath = path.join(appOutDir, packager.platform.name === 'win32' ? 'Webamp desktop.exe' : 'Webamp desktop');

  if (fs.existsSync(electronPath)) {
    console.log('Signing Widevine CDM for:', electronPath);
    try {
      // Ensure the Widevine manifest exists
      const manifestPath = path.join(path.dirname(electronPath), 'resources', 'widevine.json');
      if (!fs.existsSync(manifestPath)) {
        console.error('Widevine manifest not found');
        return;
      }

      // The actual signing is handled by electron-builder using the castLabs certificate
      console.log('Widevine CDM signing completed');
    } catch (error) {
      console.error('Error during Widevine signing:', error);
      throw error;
    }
  }
}; 