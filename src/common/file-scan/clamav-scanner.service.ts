import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'net';

export interface ScanResult {
  infected: boolean;
  /** Malware signature reported by the scanner, when infected. */
  signature: string | null;
}

const CHUNK_SIZE = 64 * 1024;

/**
 * ClamAvScannerService
 *
 * Streams a buffer to a clamd daemon over TCP using the INSTREAM command and
 * parses the verdict. Any scanner or transport error is thrown so the scan
 * job is retried — a file is never treated as clean without a verdict.
 */
@Injectable()
export class ClamAvScannerService {
  constructor(private readonly config: ConfigService) {}

  scan(data: Buffer): Promise<ScanResult> {
    const host = this.config.get<string>('CLAMAV_HOST', 'localhost');
    const port = Number(this.config.get<number>('CLAMAV_PORT', 3310));
    const timeout = Number(this.config.get<number>('CLAMAV_TIMEOUT_MS', 30000));

    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const response: Buffer[] = [];

      socket.setTimeout(timeout, () => {
        socket.destroy(new Error(`ClamAV scan timed out after ${timeout} ms`));
      });
      socket.on('error', reject);
      socket.on('data', (chunk) => response.push(chunk));
      socket.on('end', () => {
        try {
          resolve(this.parseResponse(Buffer.concat(response).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });

      socket.connect(port, host, () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
          const chunk = data.subarray(offset, offset + CHUNK_SIZE);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        // A zero-length chunk terminates the stream.
        socket.end(Buffer.alloc(4));
      });
    });
  }

  /** clamd replies `stream: OK`, `stream: <signature> FOUND` or `... ERROR`. */
  private parseResponse(raw: string): ScanResult {
    const reply = raw.replace(/\0/g, '').trim();
    if (reply.endsWith('OK')) {
      return { infected: false, signature: null };
    }
    const found = reply.match(/^stream:\s*(.+)\s+FOUND$/);
    if (found) {
      return { infected: true, signature: found[1] };
    }
    throw new Error(`Unexpected ClamAV response: ${reply || '<empty>'}`);
  }
}
