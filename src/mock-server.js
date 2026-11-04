import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const MOCK_ROOT = path.join(ROOT_DIR, 'mock_remote_root');
const KEYS_DIR = path.join(ROOT_DIR, '.keys');

// Garante pasta mock e chaves
if (!fs.existsSync(MOCK_ROOT)) {
  fs.mkdirSync(MOCK_ROOT, { recursive: true });
  // Cria alguns arquivos iniciais de teste
  fs.writeFileSync(path.join(MOCK_ROOT, 'app.log'), '2026-11-03 22:30:00 [INFO] Servidor mock iniciado com sucesso.\n2026-11-03 22:31:00 [DEBUG] Conexões ativas: 1\n');
  fs.writeFileSync(path.join(MOCK_ROOT, 'config.env'), 'PORT=8080\nNODE_ENV=production\nDATABASE_URL=postgres://mock:secret@127.0.0.1:5432/app\n');
  fs.writeFileSync(path.join(MOCK_ROOT, 'welcome.txt'), 'Bem-vindo ao servidor SSH Mock para testes do MCP Server!\n');
  const srcSubdir = path.join(MOCK_ROOT, 'app');
  fs.mkdirSync(srcSubdir, { recursive: true });
  fs.writeFileSync(path.join(srcSubdir, 'server.js'), 'console.log("Mock app executando com sucesso!");\n');
}

if (!fs.existsSync(KEYS_DIR)) {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
}

const HOST_KEY_FILE = path.join(KEYS_DIR, 'host_rsa_key');
if (!fs.existsSync(HOST_KEY_FILE)) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  fs.writeFileSync(HOST_KEY_FILE, privateKey, 'utf-8');
}

const hostPrivateKey = fs.readFileSync(HOST_KEY_FILE);

/**
 * Resolve caminhos remotos para a pasta MOCK_ROOT com segurança
 */
function resolveMockPath(remotePath) {
  let clean = remotePath || '';
  if (clean.startsWith('/') || clean.startsWith('\\')) {
    clean = clean.slice(1);
  }
  const target = path.resolve(MOCK_ROOT, clean);
  if (!target.startsWith(MOCK_ROOT)) {
    return MOCK_ROOT;
  }
  return target;
}

const OPEN_HANDLES = new Map();
let handleCounter = 1;

export function startMockServer(port = 2222) {
  return new Promise((resolve, reject) => {
    const server = new Server({
      hostKeys: [hostPrivateKey]
    }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
          // Permite mockuser/mockpass ou admin/admin123
          if ((ctx.username === 'mockuser' && ctx.password === 'mockpass') ||
              (ctx.username === 'admin' && ctx.password === 'admin123')) {
            return ctx.accept();
          }
        }
        ctx.reject(['password']);
      });

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();

          // Suporte a execução de comandos SSH (exec)
          session.on('exec', (acceptExec, rejectExec, info) => {
            const stream = acceptExec();
            const cmd = info.command.trim();

            if (cmd === 'uptime') {
              stream.write(' 22:35:00 up 10 days, 2 users, load average: 0.05, 0.03, 0.00\r\n');
              stream.exit(0);
              stream.end();
            } else if (cmd === 'whoami') {
              stream.write('mockuser\r\n');
              stream.exit(0);
              stream.end();
            } else if (cmd === 'uname -a') {
              stream.write('Linux mock-server 5.15.0-generic #1 SMP x86_64 GNU/Linux\r\n');
              stream.exit(0);
              stream.end();
            } else if (cmd.startsWith('echo ')) {
              const text = cmd.slice(5).replace(/^["']|["']$/g, '');
              stream.write(`${text}\r\n`);
              stream.exit(0);
              stream.end();
            } else if (cmd.startsWith('cat ')) {
              const fileParam = cmd.slice(4).trim().replace(/^["']|["']$/g, '');
              const resolved = resolveMockPath(fileParam);
              if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                stream.write(fs.readFileSync(resolved));
                stream.exit(0);
              } else {
                stream.stderr.write(`cat: ${fileParam}: No such file or directory\r\n`);
                stream.exit(1);
              }
              stream.end();
            } else if (cmd.startsWith('rm -rf ') || cmd.startsWith('rm ')) {
              const fileParam = cmd.replace(/^rm\s+(-rf\s+)?/, '').trim().replace(/^["']|["']$/g, '');
              const resolved = resolveMockPath(fileParam);
              if (fs.existsSync(resolved)) {
                fs.rmSync(resolved, { recursive: true, force: true });
                stream.exit(0);
              } else {
                stream.stderr.write(`rm: cannot remove '${fileParam}': No such file or directory\r\n`);
                stream.exit(1);
              }
              stream.end();
            } else if (cmd.startsWith('ls')) {
              try {
                const files = fs.readdirSync(MOCK_ROOT);
                stream.write(files.join('\r\n') + '\r\n');
                stream.exit(0);
              } catch (e) {
                stream.stderr.write(e.message + '\r\n');
                stream.exit(1);
              }
              stream.end();
            } else {
              // Resposta genérica para testes de comandos livres
              stream.write(`[MOCK EXEC] Executou comando: ${cmd}\r\n`);
              stream.exit(0);
              stream.end();
            }
          });

          // Suporte completo a SFTP
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp();

            sftp.on('REALPATH', (reqid, reqPath) => {
              sftp.name(reqid, [{ filename: reqPath || '/' }]);
            });

            sftp.on('STAT', (reqid, reqPath) => {
              const resolved = resolveMockPath(reqPath);
              fs.stat(resolved, (err, stats) => {
                if (err) return sftp.status(reqid, 2); // SSH_FX_NO_SUCH_FILE
                sftp.attrs(reqid, {
                  mode: stats.mode,
                  uid: 1000,
                  gid: 1000,
                  size: stats.size,
                  atime: Math.floor(stats.atimeMs / 1000),
                  mtime: Math.floor(stats.mtimeMs / 1000)
                });
              });
            });

            sftp.on('LSTAT', (reqid, reqPath) => {
              const resolved = resolveMockPath(reqPath);
              fs.lstat(resolved, (err, stats) => {
                if (err) return sftp.status(reqid, 2);
                sftp.attrs(reqid, {
                  mode: stats.mode,
                  uid: 1000,
                  gid: 1000,
                  size: stats.size,
                  atime: Math.floor(stats.atimeMs / 1000),
                  mtime: Math.floor(stats.mtimeMs / 1000)
                });
              });
            });

            sftp.on('FSTAT', (reqid, handle) => {
              const hId = handle.readUInt32BE(0);
              const fd = OPEN_HANDLES.get(hId);
              if (typeof fd !== 'number') return sftp.status(reqid, 4);
              fs.fstat(fd, (err, stats) => {
                if (err) return sftp.status(reqid, 4);
                sftp.attrs(reqid, {
                  mode: stats.mode,
                  uid: 1000,
                  gid: 1000,
                  size: stats.size,
                  atime: Math.floor(stats.atimeMs / 1000),
                  mtime: Math.floor(stats.mtimeMs / 1000)
                });
              });
            });

            sftp.on('SETSTAT', (reqid, reqPath, attrs) => {
              sftp.status(reqid, 0);
            });

            sftp.on('FSETSTAT', (reqid, handle, attrs) => {
              sftp.status(reqid, 0);
            });

            sftp.on('OPEN', (reqid, filename, flags) => {
              const resolved = resolveMockPath(filename);
              const nodeFlags = utils.sftp.flagsToString(flags);
              fs.open(resolved, nodeFlags, (err, fd) => {
                if (err) return sftp.status(reqid, 2);
                const handle = Buffer.alloc(4);
                const hId = handleCounter++;
                handle.writeUInt32BE(hId, 0);
                OPEN_HANDLES.set(hId, fd);
                sftp.handle(reqid, handle);
              });
            });

            sftp.on('READ', (reqid, handle, offset, length) => {
              const hId = handle.readUInt32BE(0);
              const fd = OPEN_HANDLES.get(hId);
              if (fd === undefined) return sftp.status(reqid, 4); // SSH_FX_FAILURE
              const buffer = Buffer.alloc(length);
              fs.read(fd, buffer, 0, length, offset, (err, bytesRead) => {
                if (err) return sftp.status(reqid, 4);
                if (bytesRead === 0) return sftp.status(reqid, 1); // SSH_FX_EOF
                sftp.data(reqid, buffer.subarray(0, bytesRead));
              });
            });

            sftp.on('WRITE', (reqid, handle, offset, data) => {
              const hId = handle.readUInt32BE(0);
              const fd = OPEN_HANDLES.get(hId);
              if (fd === undefined) return sftp.status(reqid, 4);
              fs.write(fd, data, 0, data.length, offset, (err) => {
                if (err) return sftp.status(reqid, 4);
                sftp.status(reqid, 0); // SSH_FX_OK
              });
            });

            sftp.on('CLOSE', (reqid, handle) => {
              const hId = handle.readUInt32BE(0);
              const item = OPEN_HANDLES.get(hId);
              if (item !== undefined) {
                OPEN_HANDLES.delete(hId);
                if (typeof item === 'number') {
                  fs.close(item, () => sftp.status(reqid, 0));
                } else {
                  sftp.status(reqid, 0);
                }
              } else {
                sftp.status(reqid, 0);
              }
            });

            sftp.on('OPENDIR', (reqid, reqPath) => {
              const resolved = resolveMockPath(reqPath);
              try {
                const files = fs.readdirSync(resolved, { withFileTypes: true });
                const handle = Buffer.alloc(4);
                const hId = handleCounter++;
                handle.writeUInt32BE(hId, 0);
                OPEN_HANDLES.set(hId, { path: resolved, files, sent: false });
                sftp.handle(reqid, handle);
              } catch (err) {
                sftp.status(reqid, 2); // SSH_FX_NO_SUCH_FILE
              }
            });

            sftp.on('READDIR', (reqid, handle) => {
              const hId = handle.readUInt32BE(0);
              const dirState = OPEN_HANDLES.get(hId);
              if (!dirState) return sftp.status(reqid, 4);

              if (dirState.sent) {
                return sftp.status(reqid, 1); // SSH_FX_EOF
              }

              const nameList = dirState.files.map(dirent => {
                const fullItemPath = path.join(dirState.path, dirent.name);
                let stats = { mode: dirent.isDirectory() ? 0o040755 : 0o100644, size: 0, mtimeMs: Date.now() };
                try {
                  stats = fs.statSync(fullItemPath);
                } catch (_) {}

                return {
                  filename: dirent.name,
                  longname: `${dirent.isDirectory() ? 'd' : '-'}rwxr-xr-x 1 mockuser mock ${stats.size} ${dirent.name}`,
                  attrs: {
                    mode: stats.mode,
                    size: stats.size,
                    mtime: Math.floor(stats.mtimeMs / 1000)
                  }
                };
              });

              dirState.sent = true;
              sftp.name(reqid, nameList);
            });

            const handleRemove = (reqid, reqPath) => {
              const resolved = resolveMockPath(reqPath);
              fs.unlink(resolved, (err) => {
                if (err) return sftp.status(reqid, 4);
                sftp.status(reqid, 0);
              });
            };

            sftp.on('REMOVE', handleRemove);
            sftp.on('UNLINK', handleRemove);

            sftp.on('RMDIR', (reqid, reqPath) => {
              const resolved = resolveMockPath(reqPath);
              fs.rmdir(resolved, (err) => {
                if (err) return sftp.status(reqid, 4);
                sftp.status(reqid, 0);
              });
            });

            sftp.on('MKDIR', (reqid, reqPath) => {
              const resolved = resolveMockPath(reqPath);
              fs.mkdir(resolved, (err) => {
                if (err) return sftp.status(reqid, 4);
                sftp.status(reqid, 0);
              });
            });
          });
        });
      });
    });

    server.listen(port, '127.0.0.1', () => {
      console.error(`[Mock SSH Server] Rodando em 127.0.0.1:${port}`);
      console.error(`[Mock SSH Server] Usuários: mockuser / mockpass ou admin / admin123`);
      console.error(`[Mock SSH Server] Diretório raiz emulado: ${MOCK_ROOT}`);
      resolve(server);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

// Se executado diretamente pelo terminal
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startMockServer(2222).catch(err => {
    console.error('Erro ao iniciar mock server:', err);
    process.exit(1);
  });
}
