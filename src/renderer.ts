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

declare global {
  interface Window {
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => void;
      on: (channel: string, func: (...args: any[]) => void) => void;
    };
  }
}

const ipcRenderer = window.ipcRenderer;

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

// Add this before webamp initialization
const DUMMY_AUDIO_URL = 'about:blank';

// Add this constant at the top level
const SILENT_AUDIO = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjIwLjEwMAAAAAAAAAAAAAAA//tUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAAFbgBtbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1t//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjM1AAAAAAAAAAAAAAAAJAYAAAAAAAAABWPsO3JQwA==';

// Add these variables at the top level
let lastSpotifyPosition = 0;
let isSeekingFromWebamp = false;

// Add a variable to store current track duration
let currentTrackDuration = 0;

// Add a flag to track resume operations
let isResumingPlayback = false;

// Add this flag at the top level
let isTrackChangeInProgress = false;

// Add this flag at the top level
let lastPlayedTrackUri: string | null = null;

// Add this at the top level
const dummyAudioCache = new Map<string, string>();

// Add at the top level after imports
let isOverWebamp = false;

// Add at the top level
let lastResyncTime = 0;
const RESYNC_DEBOUNCE_MS = 500; // Minimum time between resyncs

// Add this flag at the top level
let isPlaybackStarting = false;

// Add at the top level
let initialPlaybackHandled = false;

// Add at the top level
let isAuthenticated = false;

// Add this variable at the top level
let isVolumeChanging = false;

// Add this at the top level
let isAuthenticating = false;
let lastAuthAttempt = 0;
const AUTH_DEBOUNCE_TIME = 1000; // 1 second debounce

// Function to get canvas reference
function getCanvas(): HTMLCanvasElement | null {
  if (!canvasRef) {
    canvasRef = document.querySelector('#webamp #main-window #visualizer2') as HTMLCanvasElement;
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
              },
              // Set initial volume to match slider
              volume: parseInt((document.querySelector('input[type="range"][title="Volume Bar"]') as HTMLInputElement)?.value || '78') / 100
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
            spotifyPlayer.addListener('player_state_changed', async (state: SpotifyPlaybackState) => {
              console.log('Playback state changed:', state);
              if (state) {
                const wasPlaying = isSpotifyPlaying;
                isSpotifyPlaying = !state.paused;

                // Handle initial playback
                if (isSpotifyPlaying && !wasPlaying) {
                  isPlaybackStarting = true;
                  initialPlaybackHandled = false;
                  // Wait a bit before allowing seeks
                  setTimeout(() => {
                    isPlaybackStarting = false;
                  }, 1000);
                }

                // Only handle position updates if we're not in the initial playback start
                if (!isPlaybackStarting) {
                  // If this is the first position update after initial playback
                  if (state.position > 0 && !initialPlaybackHandled) {
                    initialPlaybackHandled = true;
                    // Update Webamp's position to match Spotify
                    const seekBar = document.getElementById('position') as HTMLInputElement;
                    if (seekBar) {
                      const percentage = (state.position / state.duration) * 100;
                      seekBar.value = percentage.toString();
                      seekBar.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }
                }

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
async function playSpotifyTrack(uri: string, startPosition: number = 0) {
  console.log('Starting playback...', { uri, startPosition });
  
  // Check if this is a local file
  if (uri.startsWith('spotify:local:')) {
    console.log('Local file detected, cannot play through Spotify Web Playback SDK');
    throw new Error('Local files are not supported in Spotify Web Playback SDK');
  }

  // Ensure player is initialized
  if (!spotifyPlayer || !currentDeviceId) {
    console.log('Player not initialized, initializing...');
    try {
      await initSpotifyPlayer();
      // Wait a bit for the player to be ready
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('Failed to initialize player:', error);
      throw error;
    }
  }

  if (!spotifyPlayer || !currentDeviceId) {
    throw new Error('Failed to initialize Spotify player');
  }
  
  // Get fresh token
  const tokenResponse = await fetch('http://localhost:3000/token');
  const { token } = await tokenResponse.json();

  try {
    // Get current playback state
    const stateResponse = await fetch('https://api.spotify.com/v1/me/player', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    let state = null;
    if (stateResponse.status !== 204) { // 204 means no content, player is inactive
      state = await stateResponse.json();
    }
    console.log('Current playback state:', state);

    // Transfer playback to our device first
    console.log('Transferring playback to our device...');
    const transferResponse = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_ids: [currentDeviceId],
        play: false
      })
    });

    if (!transferResponse.ok) {
      throw new Error(`Failed to transfer playback: ${transferResponse.status} ${transferResponse.statusText}`);
    }

    // Wait a bit for the transfer to take effect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Prepare request body
    const body: any = {
      uris: [uri]
    };
    
    if (startPosition > 0) {
      body.position_ms = startPosition;
    }

    // Make the playback request
    console.log('Starting playback on device:', currentDeviceId);
    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${currentDeviceId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      let errorMessage = `${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        console.error('Playback API error details:', errorData);
        errorMessage += `: ${JSON.stringify(errorData)}`;

        // If we get a 403 error, automatically skip to next track
        if (response.status === 403) {
          console.log('Track unavailable (403), skipping to next track...');
          // Find and click the next button
          const nextButton = document.querySelector('#main-window #next') as HTMLElement;
          if (nextButton) {
            nextButton.click();
            return; // Exit the function early
          }
        }
      } catch (e) {
        console.error('Could not parse error response:', e);
      }
      throw new Error(`Playback failed: ${errorMessage}`);
    }

    isSpotifyPlaying = true;
    console.log('Playback started successfully');
  } catch (error) {
    console.error('Error in playback sequence:', error);
    throw error;
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

// Add this function to create a minimal WAV file with correct duration
function createSilentWavFile(durationMs: number): string {
  // Use minimal sample rate and single channel to reduce size
  const sampleRate = 8000; // Minimum sample rate that still works reliably
  const channels = 1;
  const bitsPerSample = 8;
  const numSamples = Math.ceil(sampleRate * (durationMs / 1000));
  
  // Calculate sizes
  const dataSize = numSamples * channels * (bitsPerSample / 8);
  const fileSize = 44 + dataSize; // 44 bytes for WAV header
  
  // Create buffer
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  
  // WAV header
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  // RIFF chunk descriptor
  writeString(0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeString(8, 'WAVE');
  
  // fmt sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true); // byte rate
  view.setUint16(32, channels * (bitsPerSample / 8), true); // block align
  view.setUint16(34, bitsPerSample, true);
  
  // data sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  
  // Fill with silence (128 for 8-bit audio)
  for (let i = 44; i < fileSize; i++) {
    view.setUint8(i, 128);
  }
  
  // Create blob and URL
  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
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
      
      // Create silent WAV file with correct duration
      const silentAudioUrl = createSilentWavFile(item.track.duration_ms);
      
      const track: WebampTrack & WebampSpotifyTrack = {
        metaData: {
          artist: item.track.artists[0].name,
          title: item.track.name,
          spotifyUri: item.track.uri
        },
        url: silentAudioUrl,
        duration: Math.floor(item.track.duration_ms / 1000),
        length: formatDuration(item.track.duration_ms),
        spotifyUri: item.track.uri,
        defaultName: `${item.track.name} - ${item.track.artists[0].name}`,
        isSpotifyTrack: true
      };
      
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
  
  const select = document.createElement('select');
  
  // Add a default option
  const defaultOption = document.createElement('option');
  defaultOption.text = 'Select a playlist...';
  defaultOption.value = '';
  select.appendChild(defaultOption);

  // Add Liked Songs option
  const likedSongsOption = document.createElement('option');
  likedSongsOption.text = 'Liked Songs';
  likedSongsOption.value = 'liked';
  select.appendChild(likedSongsOption);
  
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

    // Remove dropdown immediately
    document.body.removeChild(wrapper);

    // Disable all playback controls
    //disablePlaybackControls();

    // Stop current playback
    if (spotifyPlayer && isSpotifyPlaying) {
      await spotifyPlayer.pause();
      isSpotifyPlaying = false;
      updatePlaybackStateUI(false);
      
      // Pause dummy audio
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        audio.pause();
      });
    }

    // Create loading indicator
    const loadingDiv = document.createElement('div');
    loadingDiv.style.position = 'fixed';
    loadingDiv.style.top = '50%';
    loadingDiv.style.left = '50%';
    loadingDiv.style.transform = 'translate(-50%, -50%)';
    loadingDiv.style.backgroundColor = '#fff';
    loadingDiv.style.color = '#000';
    loadingDiv.style.padding = '10px';
    loadingDiv.style.zIndex = '100000';
    document.body.appendChild(loadingDiv);

    try {
      // Function to process streamed tracks
      const processStreamedTracks = async (url: string) => {
        // Clear existing playlist first
        loadingDiv.textContent = 'Clearing current playlist...';
        await webamp.setTracksToPlay([]);

        // Load tracks with streaming response
        loadingDiv.textContent = 'Starting to load tracks...';
        const response = await fetch(url);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No reader available');

        let buffer = '';
        let totalProcessed = 0;
        let totalTracks = 0;
        let currentBatch = [];
        let isFirstChunk = true;

        while (true) {
          const { done, value } = await reader.read();
          
          if (value) {
            const chunk = new TextDecoder().decode(value);
            
            // Handle the first chunk specially
            if (isFirstChunk) {
              buffer = chunk;
              isFirstChunk = false;
              
              // Extract total from the first chunk
              const totalMatch = buffer.match(/"total":(\d+)/);
              if (totalMatch) {
                totalTracks = parseInt(totalMatch[1], 10);
                loadingDiv.textContent = `Found ${totalTracks} tracks to load`;
                
                // Remove everything up to the items array
                const itemsStart = buffer.indexOf('"items":[') + 8;
                buffer = buffer.slice(itemsStart);
              }
            } else {
              buffer += chunk;
            }

            // Process complete track objects
            while (true) {
              const trackStart = buffer.indexOf('{"added_at"');
              if (trackStart === -1) break;
              
              // Find the end of the track object
              let trackEnd = -1;
              let depth = 0;
              let inString = false;
              let escape = false;
              
              for (let i = trackStart; i < buffer.length; i++) {
                const char = buffer[i];
                
                if (escape) {
                  escape = false;
                  continue;
                }
                
                if (char === '\\') {
                  escape = true;
                  continue;
                }
                
                if (char === '"' && !escape) {
                  inString = !inString;
                  continue;
                }
                
                if (!inString) {
                  if (char === '{') depth++;
                  if (char === '}') {
                    depth--;
                    if (depth === 0) {
                      trackEnd = i + 1;
                      break;
                    }
                  }
                }
              }
              
              if (trackEnd === -1) break; // Wait for more data
              
              try {
                const trackJson = buffer.slice(trackStart, trackEnd);
                const item = JSON.parse(trackJson);
                
                // Skip local files
                if (item.track.uri?.startsWith('spotify:local:')) {
                  console.log('Skipping local file:', item.track.name);
                  buffer = buffer.slice(trackEnd);
                  if (buffer.startsWith(',')) {
                    buffer = buffer.slice(1);
                  }
                  continue;
                }

                // Create track object
                const trackKey = `${item.track.name}-${item.track.artists[0].name}`;
                trackUriMap.set(trackKey, item.track.uri);
                
                const track = {
                  metaData: {
                    artist: item.track.artists[0].name,
                    title: item.track.name,
                    spotifyUri: item.track.uri
                  },
                  url: createSilentWavFile(item.track.duration_ms),
                  duration: Math.floor(item.track.duration_ms / 1000),
                  length: formatDuration(item.track.duration_ms),
                  spotifyUri: item.track.uri,
                  defaultName: `${item.track.name} - ${item.track.artists[0].name}`,
                  isSpotifyTrack: true
                };
                
                currentBatch.push(track);
                totalProcessed++;
                
                // Update progress
                loadingDiv.textContent = `Processing tracks... ${totalProcessed}/${totalTracks}`;
                
                // Add batch of 50 tracks to playlist
                if (currentBatch.length >= 50) {
                  await webamp.appendTracks(currentBatch);
                  currentBatch = [];
                  // Let UI update
                  await new Promise(resolve => setTimeout(resolve, 0));
                }
                
                // Remove the processed track and the following comma if present
                buffer = buffer.slice(trackEnd);
                if (buffer.startsWith(',')) {
                  buffer = buffer.slice(1);
                }
              } catch (error) {
                console.error('Error processing track:', error);
                // Skip to the next track
                buffer = buffer.slice(trackEnd);
                if (buffer.startsWith(',')) {
                  buffer = buffer.slice(1);
                }
              }
            }
          }
          
          if (done) {
            // Add any remaining tracks
            if (currentBatch.length > 0) {
              loadingDiv.textContent = `Adding final ${currentBatch.length} tracks...`;
              await webamp.appendTracks(currentBatch);
            }
            break;
          }
        }
      };

      if (select.value === 'liked') {
        await processStreamedTracks('http://localhost:3000/liked');
      } else {
        await processStreamedTracks(`http://localhost:3000/playlist/${select.value}`);
      }
    } catch (error) {
      console.error('Error loading tracks:', error);
      loadingDiv.textContent = 'Error loading tracks: ' + error.message;
      await new Promise(resolve => setTimeout(resolve, 2000));
    } finally {
      // Re-enable all playback controls
      enablePlaybackControls();
      document.body.removeChild(loadingDiv);
    }
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

// Function to initialize Spotify authentication
function initSpotifyAuth() {
  // Check if already authenticated
  if (isAuthenticated) {
    console.log('Already authenticated');
    return;
  }

  // Check if authentication is in progress
  if (isAuthenticating) {
    console.log('Authentication already in progress');
    return;
  }

  // Debounce check
  const now = Date.now();
  if (now - lastAuthAttempt < AUTH_DEBOUNCE_TIME) {
    console.log('Auth attempt too soon, debouncing');
    return;
  }
  lastAuthAttempt = now;

  // Set authenticating flag
  isAuthenticating = true;

  // Remove any existing player instance
  if (spotifyPlayer) {
    spotifyPlayer.disconnect();
    spotifyPlayer = null;
    currentDeviceId = null;
    playerInitializationPromise = null;
  }

  // Set up IPC listener for auth success
  window.ipcRenderer.on('spotify-auth-success', async () => {
    console.log('Authentication successful, initializing player...');
    
    // Initialize player after a short delay to ensure token is saved
    setTimeout(async () => {
      try {
        // Verify we have a valid token before initializing player
        const tokenResponse = await fetch('http://localhost:3000/token');
        const tokenData = await tokenResponse.json();
        if (tokenData.error) {
          console.error('No valid token available after auth');
          isAuthenticating = false; // Reset flag
          return;
        }

        // Initialize the player
        await initSpotifyPlayer();
        console.log('Player initialized successfully');
        
        // Mark as authenticated and update UI
        isAuthenticated = true;
        isAuthenticating = false; // Reset flag
        updateAuthenticationUI(true);
      } catch (error) {
        console.error('Failed to initialize player:', error);
        isAuthenticating = false; // Reset flag
      }
    }, 500);
  });

  // Start the authentication process
  window.ipcRenderer.send('initiate-spotify-auth');
}

// Add this debug function at the top level
function debugLogTrack(track: any) {
  if (!track) {
    console.log('Debug Track Object: null');
    return;
  }
  
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

// Function to prevent audio errors
function preventAudioErrors() {
  const audioElements = document.querySelectorAll('audio');
  audioElements.forEach(audio => {
    audio.addEventListener('error', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
    
    // Prevent loading attempts
    audio.addEventListener('loadstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  });
}

// Add this function to generate a silent audio file with specific duration
function generateSilentAudio(durationMs: number): string {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const sampleRate = audioContext.sampleRate;
  const numberOfChannels = 1;
  const frameCount = Math.ceil(sampleRate * (durationMs / 1000));
  
  const audioBuffer = audioContext.createBuffer(numberOfChannels, frameCount, sampleRate);
  const channelData = audioBuffer.getChannelData(0);
  // Fill with silence (zeros)
  for (let i = 0; i < frameCount; i++) {
    channelData[i] = 0;
  }

  // Convert to WAV
  const wavData = audioBufferToWav(audioBuffer);
  const blob = new Blob([wavData], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

// Helper function to convert AudioBuffer to WAV format
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numberOfChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const wavData = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(wavData);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write audio data
  const channelData = buffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    const sample = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }

  return wavData;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

const webamp = new Webamp({
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
  enableHotkeys: false
})

const unsubscribeOnMinimize = webamp.onMinimize(() => {
  window.minimizeElectronWindow()
})

const unsubscribeOnClose = webamp.onClose(() => {
  window.closeElectronWindow()
  unsubscribeOnMinimize()
  unsubscribeOnClose()
})

// Function to update track duration
function updateTrackDuration(track: any) {
  if (track && track.durationOverride) {
    // Force the duration to our override value
    Object.defineProperty(track, 'duration', {
      value: track.durationOverride,
      writable: false,
      configurable: false
    });
  }
}

// Function to handle time synchronization
function synchronizePlaybackTime(track: any, audio: HTMLAudioElement) {
  if (!track?.isSpotifyTrack || !spotifyPlayer) return;

  // Listen for Webamp's time updates
  audio.addEventListener('timeupdate', async (e) => {
    if (!isSpotifyPlaying || isPlaybackStarting || isResumingPlayback) return;

    const webampTime = Math.floor(audio.currentTime * 1000); // Convert to ms
    const timeDiff = Math.abs(webampTime - lastSpotifyPosition);

    // If we're near the start of the track (first 2 seconds), allow larger differences
    const isNearStart = webampTime < 2000 || lastSpotifyPosition < 2000;
    
    // Increase tolerance for time differences
    const toleranceMs = isNearStart ? 2000 : 2500;

    // Only seek if the difference is significant and we're not already seeking
    if (timeDiff > toleranceMs && !isSeekingFromWebamp && !isNearStart) {
      try {
        isSeekingFromWebamp = true;
        await spotifyPlayer.seek(webampTime);
        lastSpotifyPosition = webampTime;
      } catch (error) {
        console.error('Failed to seek Spotify playback:', error);
      } finally {
        isSeekingFromWebamp = false;
      }
    }
  });
}

// Add this function to verify track synchronization
async function verifyTrackSync(track: any) {
  if (!track?.isSpotifyTrack || !spotifyPlayer) return;

  try {
    const state = await spotifyPlayer.getCurrentState();
    if (!state?.track_window?.current_track) return;

    const spotifyTrack = state.track_window.current_track;
    const webampTrackKey = `${track.metaData.title}-${track.metaData.artist}`;
    const spotifyTrackKey = `${spotifyTrack.name}-${spotifyTrack.artists[0].name}`;

    // If tracks are out of sync
    if (webampTrackKey !== spotifyTrackKey) {
      console.log('Track out of sync, realigning...', {
        webamp: webampTrackKey,
        spotify: spotifyTrackKey
      });

      // Find the correct track in Webamp's playlist
      const playlist = document.querySelector('#playlist-window #playlist');
      if (playlist) {
        const tracks = Array.from(playlist.children);
        const correctTrack = tracks.find(t => {
          const title = t.querySelector('.track-title')?.textContent || '';
          const artist = t.querySelector('.track-artist')?.textContent || '';
          return `${title}-${artist}` === spotifyTrackKey;
        });

        if (correctTrack) {
          // Double click to play the correct track
          const event = new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          correctTrack.dispatchEvent(event);
        }
      }
    }
  } catch (error) {
    console.error('Error verifying track sync:', error);
  }
}

// Add this function to handle synchronized playback start
async function startSynchronizedPlayback(track: any, spotifyUri: string) {
  // Pause Webamp's audio elements first
  const audioElements = document.querySelectorAll('audio');
  audioElements.forEach(audio => {
    audio.pause();
  });

  // Start Spotify playback
  console.log('Starting Spotify playback...');
  await playSpotifyTrack(spotifyUri, 0);

  // Wait a bit to ensure Spotify has started
  await new Promise(resolve => setTimeout(resolve, 100));

  // Now start Webamp's playback
  console.log('Starting Webamp playback...');
  audioElements.forEach(audio => {
    audio.play();
  });
}

// Modify the onTrackDidChange handler
webamp.onTrackDidChange((track: any) => {
  console.log('Track change event triggered');
  debugLogTrack(track);

  // If we're resuming, don't process the track change
  if (isResumingPlayback) {
    console.log('Ignoring track change during resume operation');
    return;
  }

  // Reset position tracking
  lastSpotifyPosition = 0;
  isSeekingFromWebamp = false;
  currentTrackDuration = track?.duration * 1000 || 0;
  isPlaybackStarting = true; // Add this flag to prevent initial seeking

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

    // Generate dummy audio file if not cached
    if (!dummyAudioCache.has(spotifyUri) && track.durationMs) {
      const dummyAudioUrl = generateSilentAudio(track.durationMs);
      dummyAudioCache.set(spotifyUri, dummyAudioUrl);
      
      // Update track's URL
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        if (audio.src === SILENT_AUDIO) {
          audio.src = dummyAudioUrl;
        }
      });
    }

    // Only start playback if this is a new track
    if (spotifyUri !== lastPlayedTrackUri) {
      lastPlayedTrackUri = spotifyUri;
      startSynchronizedPlayback(track, spotifyUri);
    }

    // Set up audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      audio.volume = 0;
      // Use cached dummy audio if available
      if (dummyAudioCache.has(spotifyUri)) {
        audio.src = dummyAudioCache.get(spotifyUri)!;
      }
      synchronizePlaybackTime(track, audio);
    });

    // Reset playback starting flag after a short delay
    setTimeout(() => {
      isPlaybackStarting = false;
    }, 1000);
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

// Function to adjust color brightness
function adjustColorBrightness(color: string, factor: number): string {
  const rgb = color.match(/\d+/g)?.map(Number);
  if (!rgb || rgb.length < 3) return color;
  
  return `rgb(${
    Math.min(255, Math.round(rgb[0] * factor))},${
    Math.min(255, Math.round(rgb[1] * factor))},${
    Math.min(255, Math.round(rgb[2] * factor))
  })`;
}

// Function to check if a color is transparent or too dark
function isValidColor(color: string, isBackground: boolean = false): boolean {
  const rgb = color.match(/\d+/g)?.map(Number);
  if (!rgb || rgb.length < 3) return false;
  
  // Only check if color is transparent
  if (color.includes('rgba') && rgb[3] === 0) return false;
  
  return true; // Accept all non-transparent colors
}

// Function to extract lightest color from base64 image
function getAverageColorFromBase64(base64String: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = base64String;
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve('rgb(0, 255, 0)'); // Fallback color
        return;
      }
      
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      let maxBrightness = 0;
      let lightestR = 0, lightestG = 0, lightestB = 0;
      
      // Find the pixel with highest brightness
      for (let i = 0; i < data.length; i += 4) {
        // Only consider non-transparent pixels
        if (data[i + 3] > 128) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          
          // Calculate brightness (HSL lightness formula)
          const brightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
          
          if (brightness > maxBrightness) {
            maxBrightness = brightness;
            lightestR = r;
            lightestG = g;
            lightestB = b;
          }
        }
      }
      
      if (maxBrightness > 0) {
        resolve(`rgb(${lightestR}, ${lightestG}, ${lightestB})`);
      } else {
        resolve('rgb(0, 255, 0)'); // Fallback color
      }
    };
    
    img.onerror = () => {
      resolve('rgb(0, 255, 0)'); // Fallback color
    };
  });
}

// Function to get theme colors from main window
async function getThemeColors(): Promise<{ low: string, mid: string, high: string, peak: string }> {
  try {
    // Find the skin style tag
    const skinStyle = document.querySelector('style#webamp-skin');
    if (!skinStyle || !skinStyle.textContent) {
      console.log('Skin style not found, using fallback colors');
      return {
        low: 'rgb(0, 255, 0)',
        mid: 'rgb(255, 255, 0)',
        high: 'rgb(255, 0, 0)',
        peak: 'rgb(255, 255, 255)'
      };
    }

    // Extract character-52 background image
    const charMatch = skinStyle.textContent.match(/#webamp \.character-52\s*{[^}]*background-image:\s*url\(([^)]+)\)/);
    if (!charMatch) {
      console.log('Character-52 style not found, using fallback colors');
      return {
        low: 'rgb(0, 255, 0)',
        mid: 'rgb(255, 255, 0)',
        high: 'rgb(255, 0, 0)',
        peak: 'rgb(255, 255, 255)'
      };
    }

    // Get the base64 image
    const base64Image = charMatch[1];
    
    // Get average color from image
    const color = await getAverageColorFromBase64(base64Image);
    console.log('Extracted color from character-52:', color);

    // Create variations
    const rgb = color.match(/\d+/g)?.map(Number);
    if (!rgb || rgb.length < 3) {
      throw new Error('Invalid color format');
    }

    // Create brighter and darker variations
    const lowColor = color;
    const midColor = adjustColorBrightness(color, 0.7);
    const highColor = adjustColorBrightness(color, 0.4);

    return {
      low: lowColor,
      mid: midColor,
      high: highColor,
      peak: 'rgb(255, 255, 255)' // Keep peaks white for visibility
    };
  } catch (error) {
    console.log('Error getting theme colors:', error);
    return {
      low: 'rgb(0, 255, 0)', // Green
      mid: 'rgb(255, 255, 0)', // Yellow
      high: 'rgb(255, 0, 0)', // Red
      peak: 'rgb(255, 255, 255)' // White
    };
  }
}

// Cache for theme colors
let cachedThemeColors: { low: string, mid: string, high: string, peak: string } | null = null;

// Function to create gradient for a bar
async function createBarGradient(ctx: CanvasRenderingContext2D, x: number, width: number, height: number, maxHeight: number): Promise<CanvasGradient> {
  const gradient = ctx.createLinearGradient(x, maxHeight, x, maxHeight - height);
  
  // Get or update cached colors
  if (!cachedThemeColors) {
    cachedThemeColors = await getThemeColors();
  }
  
  // Calculate relative height (0-1)
  const relativeHeight = height / maxHeight;
  
  if (relativeHeight <= 0.4) {
    // Low amplitude - base color variant
    gradient.addColorStop(0, cachedThemeColors.low);
    gradient.addColorStop(1, adjustColorBrightness(cachedThemeColors.low, 0.8));
  } else if (relativeHeight <= 0.7) {
    // Medium amplitude - transition to mid color
    gradient.addColorStop(0, cachedThemeColors.low);
    gradient.addColorStop(0.6, cachedThemeColors.mid);
    gradient.addColorStop(1, cachedThemeColors.low);
  } else {
    // High amplitude - full spectrum
    gradient.addColorStop(0, cachedThemeColors.low);
    gradient.addColorStop(0.5, cachedThemeColors.mid);
    gradient.addColorStop(0.8, cachedThemeColors.high);
    gradient.addColorStop(1, cachedThemeColors.low);
  }
  
  return gradient;
}

// Function to draw visualizer
async function drawVisualizer() {
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
  const barWidth = 2; // Thinner bars
  const spacing = 6; // More space between bars
  const totalWidth = NUM_BARS * (barWidth + spacing) - spacing;
  const startX = Math.floor((canvas.width - totalWidth) / 2); // Center the bars

  // Draw each bar and its peak
  for (let i = 0; i < data.length; i++) {
    const amplitude = data[i];
    const height = Math.max(1, Math.floor(amplitude * canvas.height));
    const x = startX + i * (barWidth + spacing);
    const y = canvas.height - height;

    // Create and apply gradient for main bar
    const gradient = await createBarGradient(ctx, x, barWidth, height, canvas.height);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, height);
    
    // Draw peak for this bar
    const peakHeight = Math.max(1, Math.floor(peakAmplitudes[i] * canvas.height));
    const peakY = canvas.height - peakHeight;
    
    // Set peak color to white
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, peakY, barWidth, 1); // 1px peak line like Winamp
  }
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

  // Reset color cache
  cachedThemeColors = null;

  visualizerInterval = setInterval(() => {
    drawVisualizer().catch(console.error);
  }, 50); // Update every 50ms
}

// Function to stop visualizer animation
function stopVisualizer() {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }

  // Set all bar amplitudes to 0 but keep peaks falling
  previousAmplitudes = Array(20).fill(0);
  
  // Start a new interval just for falling peaks
  visualizerInterval = setInterval(async () => {
    const canvas = getCanvas();
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear the canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate bar dimensions
    const NUM_BARS = 20;
    const barWidth = 2;
    const spacing = 6;
    const totalWidth = NUM_BARS * (barWidth + spacing) - spacing;
    const startX = Math.floor((canvas.width - totalWidth) / 2);

    // Get or update theme colors
    if (!cachedThemeColors) {
      cachedThemeColors = await getThemeColors();
    }

    // Draw each bar (at zero height) and its falling peak
    for (let i = 0; i < NUM_BARS; i++) {
      const x = startX + i * (barWidth + spacing);
      
      // Draw bar at minimum height using theme color
      const gradient = await createBarGradient(ctx, x, barWidth, 1, canvas.height);
      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - 1, barWidth, 1);
      
      // Update and draw peak
      if (peakAmplitudes[i] > 0) {
        const peakHeight = Math.max(1, Math.floor(peakAmplitudes[i] * canvas.height));
        const peakY = canvas.height - peakHeight;
        
        // Draw peak in white
        ctx.fillStyle = cachedThemeColors.peak;
        ctx.fillRect(x, peakY, barWidth, 1);
        
        // Make peak fall
        peakAmplitudes[i] = Math.max(0, peakAmplitudes[i] - (PEAK_DROP_SPEED / canvas.height));
      }
    }

    // Stop the interval when all peaks have fallen
    if (peakAmplitudes.every(peak => peak === 0)) {
      clearInterval(visualizerInterval);
      visualizerInterval = null;
      
      // Draw one last frame with minimal amplitudes
      drawVisualizer();
    }
  }, 50); // Update every 50ms
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
        // Update current track duration
        currentTrackDuration = state.duration;
        
        // Only update if we're not seeking from Webamp
        if (!isSeekingFromWebamp) {
          lastSpotifyPosition = state.position;
        }
        updatePlaybackStateUI(!state.paused);
        
        // Update document title with current track info
        if (state.track_window?.current_track) {
          const { name, artists } = state.track_window.current_track;
          document.title = `${name} - ${artists[0].name}`;
        }

        // Check if track has ended (position is at or very close to duration)
        if (state.position >= state.duration - 500) { // 500ms buffer
          // Get the next track button and playlist
          const nextButton = document.querySelector('#main-window #next') as HTMLElement;
          const playlist = document.querySelector('#playlist-window #playlist');
          
          if (nextButton && playlist) {
            // Check if there's a next track in the playlist
            const currentTrack = playlist.querySelector('.selected');
            const nextTrack = currentTrack?.nextElementSibling;
            
            if (nextTrack) {
              // Click next only if there's actually a next track
              console.log('Track ending, moving to next track');
              nextButton.click();
              
              // Wait a short moment and ensure playback continues
              setTimeout(async () => {
                const newState = await spotifyPlayer.getCurrentState();
                if (newState?.paused) {
                  await spotifyPlayer.resume();
                  isSpotifyPlaying = true;
                  updatePlaybackStateUI(true);
                }
              }, 500);
            } else {
              // If no next track, handle end of playlist
              console.log('End of playlist reached');
              isSpotifyPlaying = false;
              updatePlaybackStateUI(false);
              stopVisualizer();
              if (playbackStateInterval) {
                clearInterval(playbackStateInterval);
                playbackStateInterval = null;
              }
            }
          }
        }

        // If track has been paused externally
        if (state.paused && isSpotifyPlaying) {
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
    
    // Set up second visualizer
    setupSecondVisualizer();
    
    // Draw initial visualizer state
    drawVisualizer();
    
    // Set up seeking bar
    setupSeekingBar();

    // Initialize authentication UI state
    updateAuthenticationUI(false);

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
          if (isAuthenticated) {
            showPlaylistSelector(ejectButton);
          }
        }, { passive: false });
      }

      // Set up playlist action buttons
      setupPlaylistActionButtons();

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

// Add this function to handle seeking bar changes
function setupSeekingBar() {
  const seekingBar = document.getElementById('position') as HTMLInputElement;
  if (!seekingBar) return;

  seekingBar.addEventListener('change', async (e) => {
    if (!spotifyPlayer || !isSpotifyPlaying || isResumingPlayback) return;

    try {
      // Get current state to get accurate duration
      const state = await spotifyPlayer.getCurrentState();
      if (!state) return;

      // Calculate new position based on percentage of total duration
      const percentage = parseFloat(seekingBar.value);
      const newPosition = Math.floor(state.duration * (percentage / 100));

      // Don't seek if we're very close to the start (first 2 seconds) and the percentage is small
      if (state.position < 2000 && percentage <= 1) {
        console.log('Ignoring seek near start of track');
        return;
      }

      console.log('Seeking to position:', { 
        percentage,
        newPosition,
        totalDuration: state.duration
      });

      isSeekingFromWebamp = true;
      await spotifyPlayer.seek(newPosition);
      lastSpotifyPosition = newPosition;
    } catch (error) {
      console.error('Failed to seek Spotify playback:', error);
    } finally {
      isSeekingFromWebamp = false;
    }
  });
}

// Function to handle resuming playback
async function handleResume(state: SpotifyPlaybackState) {
  if (!spotifyPlayer || !currentDeviceId) return;

  try {
    isResumingPlayback = true;
    // Get current track URI
    const currentTrackUri = state.track_window?.current_track?.uri;
    if (!currentTrackUri) return;

    // Get current position from seeking bar
    const seekingBar = document.getElementById('position') as HTMLInputElement;
    if (!seekingBar) return;
    const percentage = parseFloat(seekingBar.value);
    const position = Math.floor(state.duration * (percentage / 100));

    console.log('Resuming playback:', { currentTrackUri, position });

    // Get fresh token
    const tokenResponse = await fetch('http://localhost:3000/token');
    const tokenData = await tokenResponse.json();
    if (tokenData.error) throw new Error('No valid token available');

    // First ensure we're the active device
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.token}`
      },
      body: JSON.stringify({
        device_ids: [currentDeviceId]
      })
    });

    // Wait for device activation
    await new Promise(resolve => setTimeout(resolve, 300));

    // Resume playback with position
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${currentDeviceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.token}`
      },
      body: JSON.stringify({
        uris: [currentTrackUri],
        position_ms: position
      })
    });

    // Add a delay before resuming the dummy audio to ensure Spotify has started
    await new Promise(resolve => setTimeout(resolve, 500));

    isSpotifyPlaying = true;
    updatePlaybackStateUI(true);
    startVisualizer();
    startPlaybackStateMonitoring();

    // Resume dummy audio
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      audio.currentTime = position / 1000;
      audio.play();
    });

    // Reset resuming flag after a delay
    setTimeout(() => {
      isResumingPlayback = false;
    }, 1000);
  } catch (error) {
    console.error('Failed to resume playback:', error);
    isSpotifyPlaying = false;
    isResumingPlayback = false;
  }
}

// Modify setupSecondVisualizer function
function setupSecondVisualizer() {
  // Create and insert the new visualizer
  const mainWindow = document.querySelector('#webamp #main-window');
  if (!mainWindow) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'visualizer2';
  canvas.classList.add('visualizer');
  canvas.width = 152;
  canvas.height = 32;
  
  // Add positioning CSS
  canvas.style.position = 'absolute';
  canvas.style.top = '43px';
  canvas.style.left = '24px';
  canvas.style.width = '76px';
  canvas.style.height = '16px';
  
  mainWindow.appendChild(canvas);

  // Set up theme observer
  setupThemeObserver();

  // Add play/pause event listeners
  const playButton = document.querySelector('#main-window #play');
  const pauseButton = document.querySelector('#main-window #pause');

  if (playButton) {
    playButton.addEventListener('click', async (e) => {
      // If already playing, prevent default behavior and do nothing
      if (isSpotifyPlaying) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      try {
        const state = await spotifyPlayer.getCurrentState();
        if (!state) {
          console.log('No state, reinitializing player...');
          await initSpotifyPlayer();
        }

        // Get current state again after potential reinitialization
        const currentState = await spotifyPlayer.getCurrentState();
        if (!currentState) return;

        // If we were previously playing and just paused, resume
        if (currentState.track_window?.current_track && currentState.paused) {
          await handleResume(currentState);
        } else {
          // Otherwise start new track
          const selectedTrack = document.querySelector('#playlist-window .selected');
          const selectedTrackKey = selectedTrack ? 
            `${selectedTrack.querySelector('.track-title')?.textContent}-${selectedTrack.querySelector('.track-artist')?.textContent}` : '';
          const selectedTrackUri = trackUriMap.get(selectedTrackKey);

          if (selectedTrackUri) {
            console.log('Playing new track:', selectedTrackUri);
            lastPlayedTrackUri = selectedTrackUri;
            await playSpotifyTrack(selectedTrackUri, 0);
          }
        }
      } catch (error) {
        console.error('Play button error:', error);
        isSpotifyPlaying = false;
      }
    }, { capture: true }); // Add capture: true to handle event before Webamp
  }

  if (pauseButton) {
    pauseButton.addEventListener('click', async () => {
      if (spotifyPlayer && isSpotifyPlaying) {
        try {
          await spotifyPlayer.pause();
          isSpotifyPlaying = false;
          updatePlaybackStateUI(false);
          stopVisualizer();
          console.log('Paused playback');

          // Pause dummy audio
          const audioElements = document.querySelectorAll('audio');
          audioElements.forEach(audio => {
            audio.pause();
          });
        } catch (error) {
          console.error('Failed to pause:', error);
        }
      }
    });
  }
}

// Add cleanup for dummy audio cache
window.addEventListener('beforeunload', () => {
  // Revoke all cached dummy audio URLs
  dummyAudioCache.forEach(url => {
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  });
  dummyAudioCache.clear();
  
  // Clear existing intervals
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }
  if (playbackStateInterval) {
    clearInterval(playbackStateInterval);
    playbackStateInterval = null;
  }
});

// Add cleanup for blob URLs
window.addEventListener('beforeunload', () => {
  // Clean up all blob URLs
  const tracks = document.querySelectorAll('audio');
  tracks.forEach(track => {
    if (track.src.startsWith('blob:')) {
      URL.revokeObjectURL(track.src);
    }
  });
  
  // Clear existing intervals
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }
  if (playbackStateInterval) {
    clearInterval(playbackStateInterval);
    playbackStateInterval = null;
  }
});

// Add this function after window.onload
function setupMouseHandling() {
  // Get all Webamp windows and UI elements
  const webampWindows = ['#main-window', '#equalizer-window', '#playlist-window', '#webamp-context-menu'];
  
  // Function to check if element is part of Webamp UI
  function isWebampElement(element: HTMLElement | null): boolean {
    if (!element) return false;
    return webampWindows.some(sel => element.closest(sel)) || 
           element.closest('.spotify-playlist-wrapper') !== null ||
           element.closest('#webamp-context-menu') !== null;
  }

  // Handle mouse enter/leave for Webamp windows
  webampWindows.forEach(selector => {
    const window = document.querySelector(selector);
    if (window) {
      window.addEventListener('mouseenter', () => {
        if (!isOverWebamp) {
          isOverWebamp = true;
          ipcRenderer.send('ignoreMouseEvents', false);
        }
      });

      window.addEventListener('mouseleave', (e) => {
        const toElement = (e as MouseEvent).relatedTarget as HTMLElement;
        if (!isWebampElement(toElement)) {
          isOverWebamp = false;
          ipcRenderer.send('ignoreMouseEvents', true);
        }
      });
    }
  });

  // Handle playlist wrapper and context menu
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if ((node as HTMLElement).classList?.contains('spotify-playlist-wrapper') ||
            (node as HTMLElement).id === 'webamp-context-menu') {
          const element = node as HTMLElement;
          element.addEventListener('mouseenter', () => {
            if (!isOverWebamp) {
              isOverWebamp = true;
              ipcRenderer.send('ignoreMouseEvents', false);
            }
          });

          element.addEventListener('mouseleave', (e) => {
            const toElement = (e as MouseEvent).relatedTarget as HTMLElement;
            if (!isWebampElement(toElement)) {
              isOverWebamp = false;
              ipcRenderer.send('ignoreMouseEvents', true);
            }
          });
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Handle clicks outside Webamp windows
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!isWebampElement(target)) {
      isOverWebamp = false;
      ipcRenderer.send('ignoreMouseEvents', true);
    }
  });
}

// Add this line to window.onload
window.onload = async () => {
  // ... existing code ...
  
  setupMouseHandling();
  
  // Set up volume slider
  const volumeSlider = document.querySelector('input[type="range"][title="Volume Bar"]') as HTMLInputElement;
  if (volumeSlider) {
    // Set initial volume when player is ready
    const initialVolume = parseInt(volumeSlider.value) / 100;
    if (spotifyPlayer) {
      await spotifyPlayer.setVolume(initialVolume);
    }

    // Handle volume changes
    volumeSlider.addEventListener('input', async () => {
      await synchronizeVolume(volumeSlider);
    });

    // Also handle change event for when the user stops dragging
    volumeSlider.addEventListener('change', async () => {
      await synchronizeVolume(volumeSlider);
    });
  }
};

// Add these functions near the top
function disablePlaybackControls() {
  const controls = [
    '#main-window .actions #play',
    '#main-window .actions #pause',
    '#main-window .actions #stop',
    '#main-window .actions #previous',
    '#main-window .actions #next',
    '#main-window #eject'
  ];
  
  controls.forEach(selector => {
    const button = document.querySelector(selector) as HTMLElement;
    if (button) {
      button.style.pointerEvents = 'none';
      button.style.opacity = '0.5';
    }
  });
}

function enablePlaybackControls() {
  const controls = [
    '#main-window .actions #play',
    '#main-window .actions #pause',
    '#main-window .actions #stop',
    '#main-window .actions #previous',
    '#main-window .actions #next',
    '#main-window #eject'
  ];
  
  controls.forEach(selector => {
    const button = document.querySelector(selector) as HTMLElement;
    if (button) {
      button.style.pointerEvents = 'auto';
      button.style.opacity = '1';
    }
  });
}

// Add this function to handle play button click
function setupPlaybackControls() {
  const playButton = document.querySelector('#main-window .actions #play') as HTMLElement;
  if (playButton) {
    playButton.addEventListener('click', async (e) => {
      // If already playing, do nothing
      if (isSpotifyPlaying) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    });
  }
}

// Function to handle track playback
async function handleTrackPlay(trackKey: string) {
  console.log('Track lookup:', { trackKey, spotifyUri: trackUriMap.get(trackKey) });
  const uri = trackUriMap.get(trackKey);
  
  if (!uri) {
    console.error('No Spotify URI found for track:', trackKey);
    return;
  }

  // Check if this is a Spotify track
  if (uri.startsWith('spotify:track:') || uri.startsWith('spotify:local:')) {
    console.log('Spotify track detected:', {
      name: trackKey.split('-')[1].trim(),
      artist: trackKey.split('-')[0].trim(),
      uri,
      playerInitialized: !!spotifyPlayer,
      deviceId: currentDeviceId
    });

    // For local files, just let Webamp handle playback
    if (uri.startsWith('spotify:local:')) {
      console.log('Local file detected, letting Webamp handle playback');
      return;
    }

    console.log('Starting Spotify playback...');
    try {
      await playSpotifyTrack(uri);
    } catch (error) {
      console.error('Failed to start Spotify playback:', error);
    }
  }
}

// Add this function after the existing functions
function updateAuthenticationUI(isAuthenticated: boolean) {
  // Disable/enable About button
  const aboutButton = document.querySelector('#main-window #about') as HTMLElement;
  if (aboutButton) {
    aboutButton.style.pointerEvents = isAuthenticated ? 'none' : 'auto';
    aboutButton.style.opacity = isAuthenticated ? '0.5' : '1';
  }

  // Disable/enable Eject button
  const ejectButton = document.querySelector('#main-window #eject') as HTMLElement;
  if (ejectButton) {
    ejectButton.style.pointerEvents = isAuthenticated ? 'auto' : 'none';
    ejectButton.style.opacity = isAuthenticated ? '1' : '0.5';
  }
}

// Function to handle volume synchronization
async function synchronizeVolume(volumeSlider: HTMLInputElement) {
  if (!spotifyPlayer || isVolumeChanging) return;

  try {
    isVolumeChanging = true;
    const volume = parseInt(volumeSlider.value) / 100;
    await spotifyPlayer.setVolume(volume);
    console.log('Volume set to:', volume);
  } catch (error) {
    console.error('Failed to set volume:', error);
  } finally {
    isVolumeChanging = false;
  }
}

// Function to set up playlist action buttons
function setupPlaylistActionButtons() {
  // Eject button
  const ejectButton = document.querySelector('.playlist-bottom-right .playlist-action-buttons .playlist-eject-button');
  if (ejectButton) {
    const clonedButton = ejectButton.cloneNode(true);
    ejectButton.parentNode?.replaceChild(clonedButton, ejectButton);
    
    clonedButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mainEject = document.querySelector('#main-window #eject') as HTMLElement;
      if (mainEject) {
        mainEject.click();
      }
    });
  }
}

// Function to set up theme observer
function setupThemeObserver() {
  // Create observer for the entire webamp container to catch all theme changes
  const webampContainer = document.getElementById('webamp');
  if (!webampContainer) return;

  // Function to handle skin changes
  function handleSkinChange() {
    console.log('Skin change detected');
    // Reset color cache to force recalculation
    cachedThemeColors = null;
    // Wait a bit for the skin to fully load
    setTimeout(() => {
      if (visualizerInterval) {
        drawVisualizer();
      }
    }, 100);
  }

  // Watch for skin changes through the options menu
  const optionsButton = document.querySelector('#main-window #option');
  if (optionsButton) {
    optionsButton.addEventListener('click', () => {
      // Wait for the skin menu to appear
      setTimeout(() => {
        const skinMenu = document.querySelector('#webamp-context-menu');
        if (skinMenu) {
          // Add click listener to the entire menu to catch all skin selections
          skinMenu.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.skin-menu')) {
              console.log('Skin menu option clicked');
              // Wait for skin to load and check multiple times
              for (let delay of [500, 1000, 1500]) {
                setTimeout(handleSkinChange, delay);
              }
            }
          });
        }
      }, 50);
    });
  }

  // Main observer for style changes
  const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;

    for (const mutation of mutations) {
      // Check for style or class changes
      if (mutation.type === 'attributes' && 
         (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
        const target = mutation.target as HTMLElement;
        // Only trigger on main window or its direct children changes
        if (target.id === 'main-window' || target.closest('#main-window')) {
          shouldUpdate = true;
          break;
        }
      }
      
      // Check for structural changes
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        const addedNodes = Array.from(mutation.addedNodes);
        if (addedNodes.some(node => 
          node instanceof HTMLElement && (
            node.id === 'main-window' ||
            node.classList.contains('window') ||
            node.classList.contains('selected') // Detect skin selection
          ))) {
          shouldUpdate = true;
          break;
        }
      }
    }

    if (shouldUpdate) {
      handleSkinChange();
    }
  });

  // Observe the webamp container
  observer.observe(webampContainer, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['style', 'class']
  });

  // Also observe the document body for skin menu appearance
  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        const addedNodes = Array.from(mutation.addedNodes);
        if (addedNodes.some(node => 
          node instanceof HTMLElement && 
          (node.id === 'webamp-context-menu' || node.classList.contains('skin-menu')))) {
          console.log('Skin menu appeared');
          // Wait for potential skin change
          setTimeout(handleSkinChange, 500);
        }
      }
    }
  });

  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('Theme observers set up successfully');
}
