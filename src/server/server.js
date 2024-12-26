const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = 3000;

// Add CORS and JSON middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: `http://localhost:${port}/callback`
});

let isAuthenticated = false;

app.get('/login', (req, res) => {
  const scopes = [
    'user-read-private',
    'user-read-email',
    'playlist-read-private',
    'streaming',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-library-read'
  ];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    spotifyApi.setAccessToken(data.body['access_token']);
    spotifyApi.setRefreshToken(data.body['refresh_token']);
    isAuthenticated = true;
    
    // Close the browser window and send message to the main process
    res.send(`
      <script>
        if (window.opener) {
          window.opener.postMessage('spotify-auth-success', '*');
        }
        window.close();
      </script>
    `);
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/token', (req, res) => {
  if (!isAuthenticated) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.json({ token: spotifyApi.getAccessToken() });
});

app.get('/playlists', async (req, res) => {
  if (!isAuthenticated) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const data = await spotifyApi.getUserPlaylists();
    res.json(data.body);
  } catch (error) {
    console.error('Error getting playlists:', error);
    res.status(500).send('Failed to fetch playlists');
  }
});

// Function to fetch items in batches
async function fetchAllItems(fetchFunction, limit = 50) {
  let items = [];
  let offset = 0;
  let total = Infinity;
  const batchSize = 5; // Number of parallel requests
  const delayBetweenBatches = 500; // ms

  // First request to get total
  const initialResponse = await fetchFunction({ limit, offset: 0 });
  total = initialResponse.body.total;
  items = items.concat(initialResponse.body.items);
  offset = limit;

  console.log(`Total items to fetch: ${total}`);

  while (offset < total) {
    const batchPromises = [];
    
    // Create batch of promises
    for (let i = 0; i < batchSize && offset < total; i++) {
      const currentOffset = offset;
      const promise = fetchFunction({ limit, offset: currentOffset })
        .then(response => {
          console.log(`Progress: ${Math.min(offset + limit, total)}/${total} items`);
          return response.body.items;
        })
        .catch(error => {
          console.error(`Error fetching batch at offset ${currentOffset}:`, error);
          return []; // Return empty array on error
        });
      
      batchPromises.push(promise);
      offset += limit;
    }

    // Wait for batch to complete
    const results = await Promise.all(batchPromises);
    items = items.concat(...results.filter(batch => batch.length > 0));

    // Add delay between batches
    if (offset < total) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }
  }

  console.log(`Fetch complete: ${items.length} items`);
  return items;
}

app.get('/playlist/:id/tracks', async (req, res) => {
  if (!isAuthenticated) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    console.log(`Fetching tracks for playlist ${req.params.id}...`);
    const items = await fetchAllItems(
      (options) => spotifyApi.getPlaylistTracks(req.params.id, options),
      100
    );
    console.log(`Successfully fetched ${items.length} tracks from playlist`);
    res.json({ items });
  } catch (error) {
    console.error('Error getting playlist tracks:', error);
    res.status(500).json({ 
      error: 'Failed to fetch playlist tracks',
      details: error.message
    });
  }
});

// Refresh token endpoint
app.post('/refresh_token', async (req, res) => {
  try {
    const data = await spotifyApi.refreshAccessToken();
    spotifyApi.setAccessToken(data.body['access_token']);
    res.json({ token: data.body['access_token'] });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).send('Failed to refresh token');
  }
});

// Add liked songs endpoint with streaming response
app.get('/liked', async (req, res) => {
  if (!isAuthenticated) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    console.log('Fetching liked songs...');
    
    // Send headers for streaming response
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    });

    // Start the response with an opening bracket
    res.write('{"items":[');
    
    let isFirst = true;
    let offset = 0;
    const limit = 50;
    
    while (true) {
      try {
        const response = await spotifyApi.getMySavedTracks({ limit, offset });
        const items = response.body.items;
        
        // Send each item in the batch
        for (const item of items) {
          if (!isFirst) {
            res.write(',');
          }
          isFirst = false;
          res.write(JSON.stringify(item));
        }
        
        // Break if this was the last batch
        if (items.length < limit || offset + limit >= response.body.total) {
          break;
        }
        
        offset += limit;
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between requests
      } catch (error) {
        console.error(`Error fetching batch at offset ${offset}:`, error);
        break;
      }
    }
    
    // Close the response
    res.write(']}');
    res.end();
    
  } catch (error) {
    console.error('Error fetching liked songs:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to fetch liked songs',
        details: error.message
      });
    } else {
      res.end();
    }
  }
});

module.exports = { app, spotifyApi }; 