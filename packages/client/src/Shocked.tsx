import React, { useRef, useEffect } from 'react';
import { ClientApi, Unsubscribe } from 'shocked-types';
import { ShockedProps, ConnectionStatus, Dispatch, ClearIdent } from './types';
import { Controller, ControllerContext } from './Controller';

type Disconnect = () => void;

function useControllerRef(api: ClientApi, dispatch: Dispatch, clearIdent: ClearIdent): Controller {
  const ref = useRef<Controller>();
  if (!ref.current) {
    ref.current = new Controller(api, dispatch, clearIdent);
  }

  return ref.current;
}

export default function Shocked<I=string>(props: ShockedProps<I>) {
  const {
    url, ident, clearIdent,
    networkProvider,
    api,
    dispatch,
    children,
  } = props;

  const controller = useControllerRef(api, dispatch, clearIdent);

  useEffect(() => {
    // No need to connect if there isn't any
    if (!ident || !url) return controller.setStatus(ConnectionStatus.offline);

    // The cleanup method
    let disconnect: (Disconnect | null) = null;
    let unsub: Unsubscribe;

    if (typeof networkProvider !== 'function') {
      disconnect = controller.connect(url, ident);
    } else {
      unsub = networkProvider((network) => {
        // Disconnect the previous connection
        if (disconnect) disconnect();
        disconnect = network ? controller.connect(url, ident) : null;
      });
    }

    return () => {
      if (unsub) unsub();
      if (disconnect) disconnect();
    };
  }, [ident, url, networkProvider]);

  return (
    <ControllerContext.Provider value={controller}>
      {children}
    </ControllerContext.Provider>
  );
}
