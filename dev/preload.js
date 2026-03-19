
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    recordingFinished: (data) => {
        ipcRenderer.send('webcam-recording-result', data);
    }
});
