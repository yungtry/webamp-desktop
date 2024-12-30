<p align="center">
  <a href="https://desktop.webamp.org/">
    <img src="./res/logo.svg" alt="Webamp on desktop logo" width=384 height=128>
  </a>

  <h3 align="center">Webamp on desktop with Spotify integration</h3>

  <p align="center">
    Webamp on desktop with Spotify integration inspired by <a href="https://github.com/remigallego/winampify-js">Winampify-js</a> by <a href="https://github.com/remigallego">@remigallego</a>, <a href="https://github.com/durasj/webamp-desktop">Webamp Desktop</a> by <a href="https://github.com/durasj">@durasj</a>, <a href="https://github.com/captbaritone/webamp">Webamp</a> by <a href="https://github.com/captbaritone">@captbaritone</a> and <a href="https://medium.com/@jrcharney/spotiamp-the-story-of-two-good-things-that-never-got-together-d2ca11e7e309">Spotiamp</a>
  </p>

  <p align="center">
    Check out the original Webamp on desktop <a href="https://desktop.webamp.org/">here</a> by <a href="https://github.com/durasj">@durasj</a> for more functional version of the app.
  </p>

<br>

[![Screenshot of webamp desktop on Windows](./res/screen-win.gif)](https://desktop.webamp.org/) [![Screenshot of Webamp on Linux](./res/screen-linux.png)](https://desktop.webamp.org/) [![Screenshot of Webamp on Mac OS X](./res/screen-mac.png)](https://desktop.webamp.org/)

Gimmicky unofficial app. It has some of the functionality of Winamp/Spotiamp, however it lacks a lot of the features. It's a proof of concept mostly for the looks. Based on [Webamp Desktop](https://github.com/durasj/webamp-desktop) , based on the [Webamp](https://github.com/captbaritone/webamp) - "A reimplementation of Winamp 2.9 in HTML5 and JavaScript." by the [@captbaritone](https://github.com/captbaritone)

## Downloads
Binaries will appear soon in the releases section.

## Features

### Implemented:
```
✅ Spotify authentication
✅ Spotify playlist support
✅ Spotify liked songs support
✅ Spotify playback, controls, shuffle and volume
✅ Winamp's skins partial support
✅ Pseudo-vizualizer for Spotify
```

### Planned:
```
☐ Session persistence
☐ Caching playlists and liked songs
☐ Playlist interactions (add, remove, edit)
☐ Personalized playlist support (eg. "Discover Weekly")
☐ Likes interactions (add, remove)
☐ Spotify search support
```
### Not planned:
```
❌ Equalizer support
❌ Spotify radio support
❌ Mono/Stereo mode
❌ Balance control
❌ Anything that requires modifying the original track as it would be a violation of Spotify's terms of service
```

### Maybe:
```
☐ Full vizualizer support
```
## Known issues

### Installation files are not trusted

Some operating systems, especially Windows or some browsers do not trust the installation files because they are not digitally signed and/or commonly used yet. Unfortunately, code signing certificates that would help us overcome this cost hundreds of euro per year. This project does not have any funding and therefore can't afford it. It's recommended to verify the checksum of the files if you are worried. Every commit (and therefore published checksum) is signed in this repository.

### Poor performance on Linux

Caused by the disabled hardware acceleration on the Linux. The reason is [issues with the transparency on the Chromium project](https://bugs.chromium.org/p/chromium/issues/detail?id=854601#c7).

## Developing

### Prerequisites

Make sure you have latest [node.js](https://nodejs.org/en/), [yarn](https://yarnpkg.com/lang/en/), [python](https://www.python.org/downloads/) and git installed.

### Development

Clone this repository, install dependencies and run the start script:

```
git clone https://github.com/yungtry/webamp-desktop-spotify.git
cd webamp-desktop
yarn install
python3 -m pip install --upgrade castlabs-evs
python -m castlabs_evs.vmp sign-pkg node_modules\electron\dist
# go to https://developer.spotify.com/dashboard and create an app. add Web API Web Playback SDK to the app, then add the client id and secret to the .env file. callback url by default is set to http://localhost:3000/callback
# create .env file and add your Spotify credentials
echo "SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here 
SPOTIFY_REDIRECT_URI=http://localhost:3000/callback" > .env
# edit passwords in src/server/server.js and scripts/inject-env.js
yarn start
```

### Production

Placeholder for now...

```
yarn install
yarn export-build
python -m castlabs_evs.vmp sign-pkg artifacts
```


After the build has completed, you should see one window with the app and one with developer tools. To try some changes, you can: change the code in the `./src` dir, close the current window and run the `yarn start` again.

## Kudos

This project is possible thanks to the [Webamp](https://github.com/captbaritone/webamp) from [@captbaritone](https://github.com/captbaritone), [Webamp Desktop](https://github.com/durasj/webamp-desktop) from [@durasj](https://github.com/durasj) and wonderful open source work of others like [@jberg](https://github.com/jberg) and authors of [many dependencies](https://github.com/yungtry/webamp-desktop-spotify/blob/master/package.json).

Thumbar icons on Windows by [Smashicons](https://smashicons.com).

## Disclaimer
Not affiliated with the [Winamp](http://www.winamp.com/) and [Spotify](https://www.spotify.com/). All product names, logos, and brands are property of their respective owners.