import { configureDesktopZoteroCloudTransport } from '../ui/server/routes/zoteroCloudTransport.js';

const CONFIG_TIMEOUT_MS = 30_000;

function receiveBrokerConfig() {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('The desktop UI server requires a private IPC channel.'));
      return;
    }

    const finish = (callback, value) => {
      clearTimeout(timeout);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type !== 'rigorium:zotero-broker-config') return;
      finish(resolve, { url: message.url, token: message.token, routeToken: message.routeToken });
    };
    const onDisconnect = () => finish(reject, new Error('The desktop IPC channel closed before startup.'));
    const timeout = setTimeout(
      () => finish(reject, new Error('The desktop credential broker did not initialize in time.')),
      CONFIG_TIMEOUT_MS,
    );

    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send({ type: 'rigorium:ui-bootstrap-ready' });
  });
}

configureDesktopZoteroCloudTransport(await receiveBrokerConfig());
await new Promise((resolve, reject) => {
  process.send({ type: 'rigorium:ui-bootstrap-configured' }, (error) => error ? reject(error) : resolve());
});
await import('../ui/server/index.js');
