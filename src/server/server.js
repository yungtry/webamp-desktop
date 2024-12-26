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
    'user-modify-playback-state'
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

app.get('/playlist/:id/tracks', async (req, res) => {
  if (!isAuthenticated) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const data = await spotifyApi.getPlaylistTracks(req.params.id);
    res.json(data.body);
  } catch (error) {
    console.error('Error getting playlist tracks:', error);
    res.status(500).send('Failed to fetch playlist tracks');
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

module.exports = { app, spotifyApi }; 