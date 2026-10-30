// Only loaded into the local setup window, never into the drive itself.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rdrive', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  chooseFolder: () => ipcRenderer.invoke('settings:choose-folder'),
  chooseFile: () => ipcRenderer.invoke('settings:choose-file'),
  save: (values) => ipcRenderer.invoke('settings:save', values),
});
