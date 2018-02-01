module.exports = function createEventManager(events) {
  const listeners = events.reduce((res, event) => Object.assign(res, { [event]: [] }), {});

  let delayedEmit = null;

  const manager = {
    add: (event, listener) => {
      const list = listeners[event];
      if (list === undefined) {
        throw new Error(`Unknown Event ${event}`);
      }
      list.push(listener);
      return function remove() {
        const idx = list.findIndex(l => l === listener);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      };
    },

    emit: (event, ...args) => {
      const list = listeners[event];
      list.forEach((l) => { l(...args); });
    },

    delayEmit: (delay, event, ...args) => {
      // Cancel any delayed emits
      if (delayedEmit !== null) {
        clearTimeout(delayedEmit);
        delayedEmit = null;
        return;
      }

      if (delay === 0) {
        manager.emit(event, ...args);
        return;
      }

      delayedEmit = setTimeout(() => {
        delayedEmit = null;
        manager.emit(event, ...args);
      }, delay);
    },
  };

  return manager;
};
