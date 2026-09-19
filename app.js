'use strict';
// Hostinger's Express launcher uses app.js. Requiring the bootstrap registers
// the HTTP listener synchronously, before loading the ES-module application.
require('./server.js');
