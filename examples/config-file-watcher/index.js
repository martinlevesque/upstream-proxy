
'use strict';

const fs = require('fs');
const upstreamProxy = require('../../index');
const chokidar = require('chokidar');

const PORT = 80;
const configFile = './config.json';

let proxy = new upstreamProxy({}, {}, function statHandler(stats) {
  console.log("GOT");
  console.log(stats);
});

let setConfigFromFile = () => {
  fs.readFile(configFile, 'utf8', (err, data) => {
    if (err) throw err;
    let result = proxy.setConfig( JSON.parse(data) );
    console.log( `Config set: ${result}` );
  });
}

proxy.listen(PORT, () => {
  console.log( `\nWebserver (USP) ist listening on port ${PORT}.` );
  setConfigFromFile();
}).start();

chokidar.watch(configFile).on('change', (event, path) => {
  setConfigFromFile();
});
