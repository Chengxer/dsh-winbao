'use strict';

// Minimal, sandbox-safe preload: only exposes app metadata to the page.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  appVersion: process.env.npm_package_version || '0.1.0',
});
