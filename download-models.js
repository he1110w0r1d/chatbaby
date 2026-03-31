const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
const files = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2'
];

const dest = path.join(__dirname, 'public', 'models');
fs.mkdirSync(dest, { recursive: true });

console.log('Downloading weights...');
let count = 0;
files.forEach(file => {
  const fileOut = fs.createWriteStream(path.join(dest, file));
  https.get(BASE_URL + file, response => {
    response.pipe(fileOut);
    fileOut.on('finish', () => {
      fileOut.close();
      console.log(`✅ Downloaded: ${file}`);
      count++;
      if (count === files.length + 1) console.log('All files downloaded!');
    });
  });
});

const LIB_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js';
const libOut = fs.createWriteStream(path.join(__dirname, 'public', 'face-api.min.js'));
https.get(LIB_URL, response => {
  response.pipe(libOut);
  libOut.on('finish', () => {
    libOut.close();
    console.log(`✅ Downloaded: face-api.min.js`);
    count++;
    if (count === files.length + 1) console.log('All files downloaded!');
  });
});
