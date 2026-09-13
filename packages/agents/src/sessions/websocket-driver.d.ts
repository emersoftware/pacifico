declare module 'websocket-driver' {
  import { EventEmitter } from 'node:events';
  import { Duplex } from 'node:stream';
  interface Driver extends EventEmitter {
    io: Duplex;
    start(): boolean;
    text(message: string): boolean;
    close(): void;
  }
  const websocket: {
    client(url: string, options?: { maxLength?: number }): Driver;
    server(options?: { maxLength?: number }): Driver;
  };
  export default websocket;
}
