// Temporary switch to custom webamp build
// import Webamp from 'webamp'
import Webamp from './webamp/webamp.bundle'

// Import types
import { Track as WebampTrack } from './webamp/webamp.bundle'
import type { 
    SpotifyPlayerInstance,
    SpotifyWebPlaybackError,
    SpotifyPlaybackState,
    SpotifyTrack,
    WebampSpotifyTrack,
    SpotifyPlaylist 
} from './types'

const DEFAULT_DOCUMENT_TITLE = document.title
let spotifyPlayer: SpotifyPlayerInstance | null = null;
let currentDeviceId: string | null = null;
let isSpotifyPlaying = false;
let playerInitializationPromise: Promise<boolean> | null = null;
let playbackStateInterval: NodeJS.Timeout | null = null;
let visualizerInterval: NodeJS.Timeout | null = null;

// Add this at the top level to store track mappings
const trackUriMap = new Map<string, string>();

let previousAmplitudes: number[] = Array(20).fill(0);
let peakAmplitudes: number[] = Array(20).fill(0);
const PEAK_DROP_SPEED = 0.4; // How fast the peaks fall (pixels per frame)
const PEAK_HOLD_TIME = 3; // How many frames to hold the peak before it starts falling
let peakHoldCounters: number[] = Array(20).fill(0);
let canvasRef: HTMLCanvasElement | null = null;

// Function to get canvas reference
function getCanvas(): HTMLCanvasElement | null {
  if (!canvasRef) {
    canvasRef = document.getElementById('visualizer') as HTMLCanvasElement;
  }
  return canvasRef;
}

// Function to initialize Spotify Web Playback SDK
async function initSpotifyPlayer() {
  // If already initializing, return the existing promise
  if (playerInitializationPromise) {
    return playerInitializationPromise;
  }

  playerInitializationPromise = (async () => {
    try {
      // First verify we have a valid token
      const tokenResponse = await fetch('http://localhost:3000/token');
      const tokenData = await tokenResponse.json();
      if (tokenData.error) {
        throw new Error('No valid token available');
      }

      // If we already have a player instance, try to reconnect it first
      if (spotifyPlayer) {
        try {
          const connected = await spotifyPlayer.connect();
          if (connected) {
            console.log('Reconnected existing player');
            return true;
          }
        } catch (error) {
          console.warn('Failed to reconnect existing player:', error);
        }
      }

      // Remove any existing Spotify script
      const existingScript = document.querySelector('script[src*="spotify-player.js"]');
      if (existingScript) {
        existingScript.remove();
      }

      // Set up the ready callback before loading the script
      return new Promise((resolve, reject) => {
        let timeoutId: NodeJS.Timeout;

        window.onSpotifyWebPlaybackSDKReady = () => {
          clearTimeout(timeoutId);
          try {
            console.log('Spotify SDK ready, creating player...');
            spotifyPlayer = new window.Spotify.Player({
              name: 'Webamp Desktop',
              getOAuthToken: async (cb: (token: string) => void) => {
                try {
                  const response = await fetch('http://localhost:3000/token');
                  const data = await response.json();
                  if (data.error) {
                    console.error('Failed to get token:', data.error);
                    return;
                  }
                  cb(data.token);
                } catch (error) {
                  console.error('Error getting token:', error);
                }
              }
            });

            // Error handling
            spotifyPlayer.addListener('initialization_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to initialize:', message);
              currentDeviceId = null;
              reject(new Error(message));
            });

            spotifyPlayer.addListener('authentication_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to authenticate:', message);
              currentDeviceId = null;
              playerInitializationPromise = null; // Allow retry
              // Reinitialize auth
              initSpotifyAuth();
            });

            spotifyPlayer.addListener('account_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to validate Spotify account:', message);
              currentDeviceId = null;
              playerInitializationPromise = null; // Allow retry
            });

            spotifyPlayer.addListener('playback_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to perform playback:', message);
              // Don't reset device ID here, just retry the playback
            });

            // Ready
            spotifyPlayer.addListener('ready', async ({ device_id }: { device_id: string }) => {
              console.log('Ready with Device ID', device_id);
              currentDeviceId = device_id;

              // Immediately set this device as active
              try {
                const tokenResponse = await fetch('http://localhost:3000/token');
                const tokenData = await tokenResponse.json();
                if (!tokenData.error) {
                  await fetch('https://api.spotify.com/v1/me/player', {
                    method: 'PUT',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${tokenData.token}`
                    },
                    body: JSON.stringify({
                      device_ids: [device_id],
                      play: false // Don't auto-play
                    })
                  });
                  console.log('Device set as active');
                }
              } catch (error) {
                console.error('Error setting device as active:', error);
              }

              resolve(true);
            });

            // Not ready
            spotifyPlayer.addListener('not_ready', ({ device_id }: { device_id: string }) => {
              console.log('Device ID is not ready:', device_id);
              if (currentDeviceId === device_id) {
                currentDeviceId = null;
                // Try to reconnect
                spotifyPlayer?.connect().catch(console.error);
              }
            });

            // Connect to the player
            console.log('Connecting to Spotify...');
            spotifyPlayer.connect().then(success => {
              if (success) {
                console.log('Successfully connected to Spotify');
              } else {
                console.error('Failed to connect to Spotify');
                currentDeviceId = null;
                playerInitializationPromise = null; // Allow retry
                reject(new Error('Failed to connect to Spotify'));
              }
            }).catch(error => {
              console.error('Connection error:', error);
              currentDeviceId = null;
              playerInitializationPromise = null; // Allow retry
              reject(error);
            });

            // Add state change listener
            spotifyPlayer.addListener('player_state_changed', (state: SpotifyPlaybackState) => {
              console.log('Playback state changed:', state);
              if (state) {
                isSpotifyPlaying = !state.paused;
                if (isSpotifyPlaying) {
                  startPlaybackStateMonitoring();
                } else {
                  if (playbackStateInterval) {
                    clearInterval(playbackStateInterval);
                    playbackStateInterval = null;
                  }
                  document.title = DEFAULT_DOCUMENT_TITLE;
                }
              }
            });

          } catch (error) {
            console.error('Error in SDK ready callback:', error);
            currentDeviceId = null;
            playerInitializationPromise = null;
            reject(error);
          }
        };

        // Load the Spotify Web Playback SDK
        console.log('Loading Spotify SDK...');
        const script = document.createElement('script');
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.async = true;
        script.onerror = (e) => {
          console.error('Failed to load Spotify SDK:', e);
          currentDeviceId = null;
          playerInitializationPromise = null; // Allow retry
          reject(new Error('Failed to load Spotify SDK'));
        };
        document.body.appendChild(script);

        // Set a timeout for the SDK to load
        timeoutId = setTimeout(() => {
          currentDeviceId = null;
          playerInitializationPromise = null; // Allow retry
          reject(new Error('Spotify SDK load timeout'));
        }, 10000);
      });
    } catch (error) {
      console.error('Error in initSpotifyPlayer:', error);
      currentDeviceId = null;
      playerInitializationPromise = null; // Allow retry
      throw error;
    }
  })();

  return playerInitializationPromise;
}

// Function to format duration in milliseconds to MM:SS
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Function to play a Spotify track
async function playSpotifyTrack(uri: string) {
  console.log('Starting playback attempt...', { uri, deviceId: currentDeviceId });
  
  // Ensure player is initialized
  if (!spotifyPlayer || !currentDeviceId) {
    console.log('Player not ready, initializing...');
    try {
      await initSpotifyPlayer();
    } catch (error) {
      console.error('Failed to initialize player:', error);
      return;
    }
  }
  
  if (!spotifyPlayer || !currentDeviceId) {
    console.error('Player still not initialized after retry');
    return;
  }
  
  try {
    // Get the current token
    const tokenResponse = await fetch('http://localhost:3000/token');
    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      console.error('Token error:', tokenData.error);
      throw new Error('No valid token available');
    }

    // Ensure we're the active device
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.token}`
      },
      body: JSON.stringify({
        device_ids: [currentDeviceId],
        play: false // Don't auto-play yet
      })
    });

    // Wait a moment for the transfer to complete
    await new Promise(resolve => setTimeout(resolve, 300));

    // Now try to play the track
    console.log('Starting playback...');
    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${currentDeviceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.token}`
      },
      body: JSON.stringify({
        uris: [uri]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Playback API error:', errorData);
      
      // If device not found, try to reinitialize
      if (errorData.error?.reason === 'NO_ACTIVE_DEVICE') {
        currentDeviceId = null;
        playerInitializationPromise = null;
        return playSpotifyTrack(uri); // Retry once
      }
      
      throw new Error('Playback API error');
    }

    // If successful, pause Webamp's audio playback but keep the UI state
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      audio.pause();
      audio.currentTime = 0;
    });
    
    isSpotifyPlaying = true;
    updatePlaybackStateUI(true);
    startPlaybackStateMonitoring(); // Start monitoring when playback begins

  } catch (error) {
    console.error('Error in playback sequence:', error);
    
    // Try direct SDK method as fallback
    try {
      console.log('Attempting SDK fallback...');
      await spotifyPlayer.connect();
      await spotifyPlayer.resume();
      
      // Check if it worked
      const state = await spotifyPlayer.getCurrentState();
      console.log('State after fallback:', state);
      
      if (!state) {
        // If no state, device might be lost
        currentDeviceId = null;
        playerInitializationPromise = null;
      }
    } catch (sdkError) {
      console.error('SDK fallback failed:', sdkError);
    }
  }
}

// Function to load Spotify playlists
async function loadSpotifyPlaylists(): Promise<SpotifyPlaylist[]> {
  try {
    const response = await fetch('http://localhost:3000/playlists');
    const data = await response.json();
    if (data.error) return [];
    return data.items;
  } catch (error) {
    console.error('Error loading playlists:', error);
    return [];
  }
}

// Function to load tracks from a Spotify playlist
async function loadPlaylistTracks(playlistId: string): Promise<(WebampTrack & WebampSpotifyTrack)[]> {
  console.log('Loading playlist tracks for ID:', playlistId);
  try {
    const response = await fetch(`http://localhost:3000/playlist/${playlistId}/tracks`);
    const data = await response.json();
    if (data.error) {
      console.error('Error in playlist data:', data.error);
      return [] as (WebampTrack & WebampSpotifyTrack)[];
    }
    
    console.log('Raw playlist tracks:', data.items);
    
    const tracks = data.items.map((item: any) => {
      console.log('Processing track item:', item);
      
      // Create a unique key for this track
      const trackKey = `${item.track.name}-${item.track.artists[0].name}`;
      
      // Store the URI in our map
      trackUriMap.set(trackKey, item.track.uri);
      
      const track = {
        metaData: {
          artist: item.track.artists[0].name,
          title: item.track.name,
        },
        url: 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABkYXRhAAAAAA==',
        duration: item.track.duration_ms / 1000,
        length: formatDuration(item.track.duration_ms),
      } as WebampTrack & WebampSpotifyTrack;
      
      console.log('Created track object:', track);
      return track;
    });
    
    console.log('Final tracks array:', tracks);
    return tracks;
  } catch (error) {
    console.error('Error loading playlist tracks:', error);
    return [] as (WebampTrack & WebampSpotifyTrack)[];
  }
}

// Show Spotify playlist selector
async function showPlaylistSelector(ejectButton: Element): Promise<void> {
  const ejectRect = ejectButton.getBoundingClientRect();
  
  // Remove any existing wrapper
  const existingWrapper = document.querySelector('.spotify-playlist-wrapper');
  if (existingWrapper) {
    existingWrapper.remove();
  }
  
  // Create wrapper div to handle clicks
  const wrapper = document.createElement('div');
  wrapper.className = 'spotify-playlist-wrapper';
  wrapper.style.position = 'absolute';
  wrapper.style.left = `${ejectRect.left}px`;
  wrapper.style.top = `${ejectRect.bottom + 5}px`; // 5px below the eject button
  wrapper.style.zIndex = '99999';
  wrapper.style.backgroundColor = '#000';
  wrapper.style.border = '1px solid #666';
  wrapper.style.padding = '4px';
  wrapper.style.minWidth = '200px';
  
  const select = document.createElement('select');
  select.style.width = '100%';
  select.style.backgroundColor = '#000';
  select.style.color = '#00ff00';
  select.style.border = 'none';
  select.style.outline = 'none';
  select.style.fontSize = '11px';
  select.style.fontFamily = 'Arial, sans-serif';
  
  // Add a default option
  const defaultOption = document.createElement('option');
  defaultOption.text = 'Select a playlist...';
  defaultOption.value = '';
  select.appendChild(defaultOption);
  
  // Load and populate playlists
  const playlists = await loadSpotifyPlaylists();
  playlists.forEach((playlist: SpotifyPlaylist) => {
    const option = document.createElement('option');
    option.value = playlist.id;
    option.text = playlist.name;
    select.appendChild(option);
  });
  
  // Handle playlist selection
  select.onchange = async () => {
    if (!select.value) return;
    const tracks = await loadPlaylistTracks(select.value);
    webamp.appendTracks(tracks);
    document.body.removeChild(wrapper);
  };

  // Handle click outside
  function handleClickOutside(e: MouseEvent) {
    const wrapper = document.querySelector('.spotify-playlist-wrapper');
    if (wrapper && !wrapper.contains(e.target as Node)) {
      wrapper.remove();
      document.removeEventListener('click', handleClickOutside);
    }
  }
  
  // Add small delay before adding click outside handler
  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
  }, 100);
  
  wrapper.appendChild(select);
  document.body.appendChild(wrapper);
  
  // Focus the select element
  select.focus();
}

// Initialize Spotify authentication
function initSpotifyAuth() {
  // Listen for the authentication success message
  window.addEventListener('message', async (event) => {
    if (event.data === 'spotify-auth-success') {
      console.log('Authentication successful, initializing player...');
      try {
        await initSpotifyPlayer();
        console.log('Player initialized successfully');
      } catch (error) {
        console.error('Failed to initialize player:', error);
      }
    }
  });

  // Start the authentication process
  window.ipcRenderer.send('initiate-spotify-auth');
}

// Add this debug function at the top level
function debugLogTrack(track: any) {
  console.log('Debug Track Object:', {
    fullTrack: track,
    hasMetaData: !!track?.metaData,
    metaData: track?.metaData,
    hasSpotifyUri: !!track?.spotifyUri,
    spotifyUriInMetaData: !!(track?.metaData as any)?.spotifyUri,
    keys: Object.keys(track || {}),
    prototype: Object.getPrototypeOf(track),
  });
}

const webamp = new Webamp({
  initialTracks: [
    {
      metaData: {
        artist: 'DJ Mike Llama',
        title: 'Llama Whippin\' Intro',
      },
      url: './mp3/llama-2.91.mp3'
    }
  ],
  initialSkin: {
    url: './skins/base-2.91.wsz'
  },
  availableSkins: [
    { url: './skins/base-2.91.wsz', name: 'Base v2.91' },
    { url: './skins/Green-Dimension-V2.wsz', name: 'Green Dimension V2' },
    { url: './skins/MacOSXAqua1-5.wsz', name: 'Mac OSX v1.5 (Aqua)' },
    { url: './skins/Skinner_Atlas.wsz', name: 'Skinner Atlas' },
    { url: './skins/TopazAmp1-2.wsz', name: 'TopazAmp v1.2' },
    { url: './skins/Vizor1-01.wsz', name: 'Vizor v1.01' },
    { url: './skins/XMMS-Turquoise.wsz', name: 'XMMS Turquoise' },
    { url: './skins/ZaxonRemake1-0.wsz', name: 'Zaxon Remake v1.0' },
  ],
  enableHotkeys: true
})

const unsubscribeOnMinimize = webamp.onMinimize(() => {
  window.minimizeElectronWindow()
})

const unsubscribeOnClose = webamp.onClose(() => {
  window.closeElectronWindow()
  unsubscribeOnMinimize()
  unsubscribeOnClose()
})

webamp.onTrackDidChange((track: any) => {
  console.log('Track change event triggered');
  debugLogTrack(track);

  if (!track || !track.metaData) {
    console.log('No track or metadata');
    return;
  }

  // Look up the URI from our map
  const trackKey = `${track.metaData.title}-${track.metaData.artist}`;
  const spotifyUri = trackUriMap.get(trackKey);
  
  console.log('Track lookup:', { trackKey, spotifyUri });

  if (spotifyUri) {
    console.log('Spotify track detected:', {
      name: track.metaData.title,
      artist: track.metaData.artist,
      uri: spotifyUri,
      playerInitialized: !!spotifyPlayer,
      deviceId: currentDeviceId
    });
    
    // Update document title
    document.title = `${track.metaData.title} - ${track.metaData.artist}` || DEFAULT_DOCUMENT_TITLE;
    
    // Pause any existing audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      audio.pause();
      audio.currentTime = 0;
    });

    // Ensure player is ready before attempting playback
    if (spotifyPlayer) {
      console.log('Starting playback sequence with player:', { 
        spotifyPlayer, 
        currentDeviceId,
        isSpotifyPlaying 
      });
      playSpotifyTrack(spotifyUri);
    } else {
      console.error('Spotify player not initialized during track change');
      // Try to reinitialize
      console.log('Attempting to reinitialize Spotify player...');
      initSpotifyPlayer().then(() => {
        console.log('Player reinitialized, attempting playback...');
        playSpotifyTrack(spotifyUri);
      }).catch(error => {
        console.error('Failed to reinitialize player:', error);
      });
    }
  } else {
    console.log('Non-Spotify track detected:', {
      hasTrack: !!track,
      properties: track ? Object.keys(track) : [],
      metadata: track?.metaData,
      trackKey
    });
    document.title = DEFAULT_DOCUMENT_TITLE;
  }
});

// Function to update play/stop state in UI
function updatePlaybackStateUI(isPlaying: boolean) {
  const mainWindow = document.getElementById('main-window');
  if (mainWindow) {
    const classes = mainWindow.className.split(' ').filter(c => c !== 'play' && c !== 'stop');
    classes.push(isPlaying ? 'play' : 'stop');
    mainWindow.className = classes.join(' ');
  }
}

// Function to generate fake analyzer data with smoother transitions
function generateAnalyzerData(numBars: number): number[] {
  const data = [];
  const transitionSpeed = 0.3; // Faster transitions like Winamp
  const canvas = getCanvas();
  if (!canvas) return Array(numBars).fill(0);

  for (let i = 0; i < numBars; i++) {
    // Target amplitude - use exponential distribution for more Winamp-like movement
    const targetAmplitude = isSpotifyPlaying 
      ? Math.pow(Math.random(), 2) * 0.9 + 0.1 // More variance in heights
      : Math.random() * 0.05;
    
    // Smoothly transition to target
    const currentAmplitude = previousAmplitudes[i];
    const newAmplitude = currentAmplitude + (targetAmplitude - currentAmplitude) * transitionSpeed;
    
    // Update peak for this bar
    if (newAmplitude >= peakAmplitudes[i]) {
      peakAmplitudes[i] = newAmplitude;
      peakHoldCounters[i] = PEAK_HOLD_TIME;
    } else {
      if (peakHoldCounters[i] > 0) {
        peakHoldCounters[i]--;
      } else {
        // Convert peak drop speed from pixels to amplitude
        const dropAmount = PEAK_DROP_SPEED / canvas.height;
        peakAmplitudes[i] = Math.max(newAmplitude, peakAmplitudes[i] - dropAmount);
      }
    }
    
    data.push(newAmplitude);
    previousAmplitudes[i] = newAmplitude;
  }
  return data;
}

// Function to create gradient for a bar
function createBarGradient(ctx: CanvasRenderingContext2D, x: number, width: number, height: number, maxHeight: number): CanvasGradient {
  const gradient = ctx.createLinearGradient(x, maxHeight, x, maxHeight - height);
  
  // Calculate relative height (0-1)
  const relativeHeight = height / maxHeight;
  
  if (relativeHeight <= 0.4) {
    // Low amplitude - only green
    gradient.addColorStop(0, 'rgb(0, 255, 0)');
    gradient.addColorStop(1, 'rgb(0, 200, 0)');
  } else if (relativeHeight <= 0.7) {
    // Medium amplitude - green to yellow
    gradient.addColorStop(0, 'rgb(0, 255, 0)');
    gradient.addColorStop(0.6, 'rgb(255, 255, 0)');
    gradient.addColorStop(1, 'rgb(200, 255, 0)');
  } else {
    // High amplitude - green to yellow to red
    gradient.addColorStop(0, 'rgb(0, 255, 0)');
    gradient.addColorStop(0.5, 'rgb(255, 255, 0)');
    gradient.addColorStop(0.8, 'rgb(255, 128, 0)');
    gradient.addColorStop(1, 'rgb(255, 0, 0)');
  }
  
  return gradient;
}

// Function to draw visualizer
function drawVisualizer() {
  const canvas = getCanvas();
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear the canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Generate data for exactly 20 bars
  const NUM_BARS = 20;
  const data = generateAnalyzerData(NUM_BARS);
  
  // Calculate bar width and spacing
  // Canvas is 152px wide, we want 20 bars with proper spacing
  const barWidth = 2; // Thinner bars
  const spacing = 6; // More space between bars
  const totalWidth = NUM_BARS * (barWidth + spacing) - spacing;
  const startX = Math.floor((canvas.width - totalWidth) / 2); // Center the bars

  // Draw each bar and its peak
  data.forEach((amplitude, index) => {
    const height = Math.max(1, Math.floor(amplitude * canvas.height));
    const x = startX + index * (barWidth + spacing);
    const y = canvas.height - height;

    // Create and apply gradient for main bar
    const gradient = createBarGradient(ctx, x, barWidth, height, canvas.height);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, height);
    
    // Draw peak for this bar
    const peakHeight = Math.max(1, Math.floor(peakAmplitudes[index] * canvas.height));
    const peakY = canvas.height - peakHeight;
    
    // Set peak color to white
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, peakY, barWidth, 1); // 1px peak line like Winamp
  });
}

// Function to start visualizer animation
function startVisualizer() {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
  }

  // Reset peaks when starting
  peakAmplitudes = Array(20).fill(0);
  peakHoldCounters = Array(20).fill(0);
  
  // Reset canvas reference to ensure we get the latest one
  canvasRef = null;

  visualizerInterval = setInterval(drawVisualizer, 50); // Update every 50ms
}

// Function to stop visualizer animation
function stopVisualizer() {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }

  // Draw one last frame with minimal amplitudes
  drawVisualizer();
}

// Function to start playback state monitoring
function startPlaybackStateMonitoring() {
  if (playbackStateInterval) {
    clearInterval(playbackStateInterval);
  }

  playbackStateInterval = setInterval(async () => {
    if (!spotifyPlayer || !isSpotifyPlaying) return;

    try {
      const state = await spotifyPlayer.getCurrentState();
      if (state) {
        updateTimeDisplay(state.position);
        updatePlaybackStateUI(!state.paused);
        
        // Update document title with current track info
        if (state.track_window?.current_track) {
          const { name, artists } = state.track_window.current_track;
          document.title = `${name} - ${artists[0].name}`;
        }

        // If track has ended, update isSpotifyPlaying
        if (state.paused) {
          isSpotifyPlaying = false;
          document.title = DEFAULT_DOCUMENT_TITLE;
          updatePlaybackStateUI(false);
          stopVisualizer();
          if (playbackStateInterval) {
            clearInterval(playbackStateInterval);
            playbackStateInterval = null;
          }
        }
      }
    } catch (error) {
      console.error('Error getting playback state:', error);
    }
  }, 1000); // Update every second

  // Start the visualizer when playback starts
  startVisualizer();
}

// Clean up interval when window is closed
window.addEventListener('beforeunload', () => {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }
  if (playbackStateInterval) {
    clearInterval(playbackStateInterval);
    playbackStateInterval = null;
  }
});

// Update play/pause functions
window.webampPlay = async function () {
  if (spotifyPlayer && !isSpotifyPlaying) {
    try {
      await spotifyPlayer.resume();
      isSpotifyPlaying = true;
      updatePlaybackStateUI(true);
      startVisualizer();
      console.log('Resumed playback');
    } catch (error) {
      console.error('Failed to resume:', error);
    }
  }
}

window.webampPause = async function () {
  if (spotifyPlayer && isSpotifyPlaying) {
    try {
      await spotifyPlayer.pause();
      isSpotifyPlaying = false;
      updatePlaybackStateUI(false);
      stopVisualizer();
      console.log('Paused playback');
    } catch (error) {
      console.error('Failed to pause:', error);
    }
  }
}

window.webampNext = function () {
  if (spotifyPlayer) {
    spotifyPlayer.nextTrack();
  }
}

window.webampPrevious = function () {
  if (spotifyPlayer) {
    spotifyPlayer.previousTrack();
  }
}

// Render after the skin has loaded.
const appElement = document.getElementById('app');
if (appElement) {
  webamp.renderWhenReady(appElement).then(() => {
    window.setupRendered();
    
    // Draw initial visualizer state
    drawVisualizer();
    
    // Add click handlers for About and Eject buttons
    setTimeout(() => {
      // About button for authentication
      const aboutButton = document.querySelector('#main-window #about');
      if (aboutButton) {
        aboutButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          initSpotifyAuth();
        }, { passive: false });
      }

      // Eject button for playlist selection
      const ejectButton = document.querySelector('#main-window #eject');
      if (ejectButton) {
        ejectButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showPlaylistSelector(ejectButton);
        }, { passive: false });
      }

      // Add non-passive event listeners for playlist scrolling
      const playlistWindow = document.querySelector('#playlist-window');
      if (playlistWindow) {
        playlistWindow.addEventListener('wheel', (e: WheelEvent) => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? 1 : -1;
          const scrollAmount = delta * 10;
          const element = playlistWindow as HTMLElement;
          element.scrollTop += scrollAmount;
        }, { passive: false });
      }
    }, 1000); // Give time for Webamp to fully initialize
  });
}

// Function to update time display
function updateTimeDisplay(positionMs: number) {
  const minutes = Math.floor(positionMs / 60000);
  const seconds = Math.floor((positionMs % 60000) / 1000);
  
  const minuteFirstDigit = Math.floor(minutes / 10);
  const minuteSecondDigit = minutes % 10;
  const secondFirstDigit = Math.floor(seconds / 10);
  const secondSecondDigit = seconds % 10;

  const minuteFirstElement = document.getElementById('minute-first-digit');
  const minuteSecondElement = document.getElementById('minute-second-digit');
  const secondFirstElement = document.getElementById('second-first-digit');
  const secondSecondElement = document.getElementById('second-second-digit');

  if (minuteFirstElement) minuteFirstElement.className = `digit digit-${minuteFirstDigit}`;
  if (minuteSecondElement) minuteSecondElement.className = `digit digit-${minuteSecondDigit}`;
  if (secondFirstElement) secondFirstElement.className = `digit digit-${secondFirstDigit}`;
  if (secondSecondElement) secondSecondElement.className = `digit digit-${secondSecondDigit}`;
}
