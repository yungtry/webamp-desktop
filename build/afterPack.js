const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  // Get the path to the packaged app
  const { appOutDir, packager } = context;
  const electronPath = path.join(appOutDir, packager.platform.name === 'win32' ? 'Webamp desktop.exe' : 'Webamp desktop');
  
  // Enable Widevine
  if (fs.existsSync(electronPath)) {
    console.log('Enabling Widevine CDM for:', electronPath);
    try {
      // Set the Widevine CDM flags
      const manifestPath = path.join(path.dirname(electronPath), 'resources', 'widevine.json');
      const manifest = {
        "widevine": {
          "version": "4.10.2557.0"
        }
      };
      
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log('Successfully created Widevine manifest');
    } catch (error) {
      console.error('Error setting up Widevine:', error);
      throw error;
    }
  }
}; 