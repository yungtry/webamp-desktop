const { app } = require('./server');

const port = 3000;

app.listen(port, () => {
  console.log(`Spotify auth server listening at http://localhost:${port}`);
}); 