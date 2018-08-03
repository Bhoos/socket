import { createParser, PKT_RPC_REQUEST, PKT_SCOPE_REQUEST, PKT_CALL } from 'shocked-common';

const noop = () => {};

function createClient(host, store, Socket = global.WebSocket, network = null) {
  if (!host.startsWith('ws://') && !host.startsWith('wss://')) {
    throw new Error(`Invalid host ${host}. Host should start with ws:// or wss://`);
  }

  if (!store || !store.dispatch || !store.getState || !store.subscribe) {
    throw new Error('Invalid store. Store must be a valid redux store.');
  }

  const parser = createParser();

  let serial = 0;
  let scopeSerial = 0;

  let rpcs = {};
  let scopeCalls = {};
  let scopeManifests = {};

  const listeners = {};
  const pending = [];

  function fire(event, data) {
    const eventListeners = listeners[event];
    if (eventListeners) {
      // Call the listener with client as `this` instance
      // eslint-disable-next-line no-use-before-define
      eventListeners.forEach(l => l.call(client, data));
    }
  }

  function deferSend(pkt) {
    pending.push(pkt);
    return () => {
      const idx = pending.indexOf(pkt);
      if (idx >= 0) {
        pending.splice(idx, 1);
      }
    };
  }

  function connection(remoteUrl) {
    if (remoteUrl === null) {
      return null;
    }

    const sock = new Socket(remoteUrl);

    sock.onopen = () => {
      // Execute all the pending calls
      pending.forEach(p => sock.send(p));
      pending.length = 0;

      // Trigger the connect event
      fire('connect');
    };

    sock.onmessage = (e) => {
      parser.parse(e.data);
    };

    sock.onclose = () => {
      // Clear all pending, as they will be rejected from below
      pending.length = 0;

      // Reject all rpcs and scopes with termination error
      const rejections = Object.values(rpcs).concat(Object.values(scopeCalls));
      rpcs = {};
      scopeCalls = {};
      rejections.forEach(([, reject]) => {
        reject(new Error('Connection terminated'));
      });

      // Clear all scope manifests
      scopeManifests = {};

      // Fire the close event on client
      fire('disconnect');
    };

    sock.onerror = (e) => {
      const rejections = Object.values(rpcs).concat(Object.values(scopeCalls));
      rpcs = {};
      scopeCalls = {};

      // Clear all pending tasks, as they will be rejected from below
      pending.length = 0;

      // Reject all rpcs with error
      rejections.forEach(([, reject]) => {
        reject(e.message);
      });

      // Fire the error event on client
      fire('error', e.message);
    };

    return sock;
  }

  parser.onEvent = fire;
  parser.onAction = (action) => {
    store.dispatch(action);
  };

  parser.onRpcResponse = (tracker, success, result) => {
    const [resolve, reject, scopeId] = rpcs[tracker];
    delete rpcs[tracker];
    if (success) {
      if (success === -1) {
        // the result of a proxying
        resolve(result.reduce((res, name) => {
          // eslint-disable-next-line no-use-before-define
          res[name] = (...args) => client.rpc(scopeId, name, ...args);
          return res;
        }, {}));
      } else {
        resolve(result);
      }
    } else {
      reject(result);
    }
  };

  parser.onScopeResponse = (tracker, success, result) => {
    const [resolve, reject, scopeId, manifest] = scopeCalls[tracker];
    delete scopeCalls[tracker];
    if (!success) {
      reject(result);
    } else {
      const apis = result || manifest.apis;
      const scopedApi = apis.reduce((res, api) => {
        // eslint-disable-next-line no-use-before-define
        res[api] = (...args) => client.rpc(scopeId, api, ...args);
        return res;
      }, {});

      // Store the scoped api for easy retrieval later
      scopeManifests[scopeId] = scopedApi;

      resolve(scopedApi);
    }
  };

  // Initialize with a connection attempt
  let socket = null;

  const client = {
    isConnected: () => socket && socket.readyState === Socket.OPEN,

    connect: (path) => {
      const url = `${host}${path}`;
      if (client.isConnected() && socket.url === url) {
        return true;
      }

      if (socket !== null) {
        socket.close();
      }

      socket = connection(url);
      return true;
    },

    reconnect: () => {
      // Cannot connect without a remote url
      if (socket === null) {
        return false;
      }

      // Use the given url or a last successfully connected url
      const finalUrl = socket.url;

      // Since its a reconnect attempt, we will close existing socket
      if (socket !== null) {
        socket.close();
      }

      socket = connection(finalUrl);
      return true;
    },

    close: () => {
      socket.close();
      socket = null;
    },

    on: (event, listener) => {
      // Keep track of event listeners
      const eventListeners = listeners[event];
      if (!eventListeners) {
        listeners[event] = [listener];
      } else {
        eventListeners.push(listener);
      }

      return () => {
        listeners[event] = listeners[event].filter(l => l === listener);
      };
    },

    call: (scope, api, ...args) => {
      const pkt = PKT_CALL(scope, api, args);
      if (!client.isConnected()) {
        // Add to pending tasks
        return deferSend(pkt);
      }

      // Send the request, its not an rpc, so need to keep track
      socket.send(pkt);
      return noop;
    },

    rpc: (scope, api, ...args) => new Promise((resolve, reject) => {
      serial += 1;
      rpcs[serial] = [resolve, reject, scope];
      const pkt = PKT_RPC_REQUEST(serial, scope, api, args);
      if (!client.isConnected()) {
        return deferSend(pkt);
      }

      socket.send(pkt);
      return noop();
    }),

    scope: (name, manifest = null) => new Promise((resolve, reject) => {
      // If the scope has already been manifested, return immediately
      if (scopeManifests[name]) {
        return resolve(scopeManifests[name]);
      }

      scopeSerial += 1;
      scopeCalls[scopeSerial] = [resolve, reject, name, manifest];

      const pkt = PKT_SCOPE_REQUEST(scopeSerial, name, !manifest);
      if (!client.isConnected()) {
        return deferSend(pkt);
      }

      socket.send(pkt);
      return noop;
    }),
  };

  // Setup a network change listener to keep the connection alive
  if (network) {
    network.on('online', () => {
      // Establish a connection as soon as we are online
      if (socket !== null) {
        client.reconnect();
      }
    });

    network.on('offline', () => {
      // close the socket as soon as we go offline
      if (socket !== null) {
        socket.close();
      }
    });
  }

  return client;
}

export default createClient;