let isBusy = false;
let currentTaskName = '';

module.exports = {
    isBotBusy: () => isBusy,
    getBusyTask: () => currentTaskName,
    setBotBusy: (busy, taskName = '') => {
        isBusy = busy;
        currentTaskName = busy ? taskName : '';
    }
};