import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { vault } from './crypto-vault.js';
import { SshClientManager, closeAllConnections } from './ssh-client.js';
import { startMockServer } from './mock-server.js';

// ──────────────────────────────────────────────
// Logging de auditoria em stderr (nunca stdout)
// ──────────────────────────────────────────────

function auditLog(toolName, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    ...details,
  };
  // Remove campos sensíveis antes de logar
  delete entry.password;
  delete entry.masterPassword;
  delete entry.privateKey;
  delete entry.passphrase;
  delete entry.content;
  console.error(`[AUDIT] ${JSON.stringify(entry)}`);
}

/**
 * Sanitiza mensagens de erro para não vazar informações sensíveis.
 */
function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') return 'Erro interno desconhecido.';

  // Remove possíveis IPs, paths de sistema e credenciais
  let sanitized = message;
  // Não remover IPs/paths que são informativos — apenas credenciais
  sanitized = sanitized.replace(/password[=:]\s*\S+/gi, 'password=***');
  sanitized = sanitized.replace(/key[=:]\s*-----BEGIN[\s\S]*?-----END[^-]*-----/gi, 'key=***');

  return sanitized;
}

// ──────────────────────────────────────────────
// Schemas Zod para validação de inputs
// ──────────────────────────────────────────────

const VaultInitSchema = z.object({
  masterPassword: z.string().min(1, 'Senha mestra é obrigatória.'),
});

const VaultUnlockSchema = z.object({
  masterPassword: z.string().min(1, 'Senha mestra é obrigatória.').optional(),
});

const VaultAddServerSchema = z.object({
  masterPassword: z.string().min(1).optional(),
  name: z.string().min(1, 'Nome do servidor é obrigatório.'),
  host: z.string().min(1, 'Host do servidor é obrigatório.'),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  description: z.string().optional(),
});

const VaultRemoveServerSchema = z.object({
  masterPassword: z.string().min(1).optional(),
  name: z.string().min(1, 'Nome do servidor é obrigatório.'),
});

const SshExecuteSchema = z.object({
  server: z.string().min(1, 'Nome do servidor é obrigatório.'),
  command: z.string().min(1, 'Comando é obrigatório.'),
  cwd: z.string().optional(),
  timeout: z.number().int().min(1000).max(300_000).optional(),
});

const SshReadFileSchema = z.object({
  server: z.string().min(1, 'Nome do servidor é obrigatório.'),
  remotePath: z.string().min(1, 'Caminho remoto é obrigatório.'),
  maxBytes: z.number().int().min(1).optional(),
});

const SshWriteFileSchema = z.object({
  server: z.string().min(1, 'Nome do servidor é obrigatório.'),
  remotePath: z.string().min(1, 'Caminho remoto é obrigatório.'),
  content: z.string({ required_error: 'Conteúdo é obrigatório.' }),
});

const SshDeleteFileSchema = z.object({
  server: z.string().min(1, 'Nome do servidor é obrigatório.'),
  remotePath: z.string().min(1, 'Caminho remoto é obrigatório.'),
  recursive: z.boolean().optional(),
});

const SshListDirSchema = z.object({
  server: z.string().min(1, 'Nome do servidor é obrigatório.'),
  remotePath: z.string().optional(),
});

const MockServerStartSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
});

// ──────────────────────────────────────────────
// Estado do servidor
// ──────────────────────────────────────────────

let activeMockServer = null;

const server = new Server(
  {
    name: 'mcp-ssh-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ──────────────────────────────────────────────
// Definição das tools com annotations MCP
// ──────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'vault_status',
        description: 'Exibe o status atual do cofre (se está inicializado, se está desbloqueado na memória RAM) e os servidores cadastrados (sem expor credenciais sensíveis).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'vault_init',
        description: 'Inicializa o cofre criptografado com uma nova senha mestra. Cria crypto-config.json e servers-config.enc.json.',
        inputSchema: {
          type: 'object',
          properties: {
            masterPassword: {
              type: 'string',
              description: 'A senha mestra para criptografar os dados do cofre.',
            },
          },
          required: ['masterPassword'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'vault_unlock',
        description: 'Descriptografa o cofre e carrega os servidores na memória RAM. Informe masterPassword para desbloquear.',
        inputSchema: {
          type: 'object',
          properties: {
            masterPassword: {
              type: 'string',
              description: 'Senha mestra do cofre.',
            },
          },
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'vault_lock',
        description: 'Tranca o cofre imediatamente, limpando todos os servidores e credenciais da memória RAM da sessão.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'vault_add_server',
        description: 'Adiciona ou atualiza a configuração de um servidor SSH no cofre criptografado.',
        inputSchema: {
          type: 'object',
          properties: {
            masterPassword: {
              type: 'string',
              description: 'Senha mestra para autorizar a operação.',
            },
            name: {
              type: 'string',
              description: 'Identificador único do servidor (ex: "prod-web", "staging", "mock-server").',
            },
            host: {
              type: 'string',
              description: 'Endereço IP ou hostname do servidor SSH.',
            },
            port: {
              type: 'number',
              description: 'Porta SSH (padrão: 22).',
            },
            username: {
              type: 'string',
              description: 'Usuário SSH (padrão: "root").',
            },
            password: {
              type: 'string',
              description: 'Senha de autenticação SSH (opcional se usar chave privada).',
            },
            privateKey: {
              type: 'string',
              description: 'Chave privada OpenSSH/RSA em texto PEM (opcional se usar senha).',
            },
            passphrase: {
              type: 'string',
              description: 'Passphrase da chave privada se ela for criptografada.',
            },
            description: {
              type: 'string',
              description: 'Breve descrição do propósito do servidor.',
            },
          },
          required: ['name', 'host'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'vault_remove_server',
        description: 'Remove um servidor SSH do cofre criptografado.',
        inputSchema: {
          type: 'object',
          properties: {
            masterPassword: {
              type: 'string',
              description: 'Senha mestra para autorizar a remoção.',
            },
            name: {
              type: 'string',
              description: 'Nome do servidor a ser removido.',
            },
          },
          required: ['name'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'ssh_execute',
        description:
          'Executa um comando shell/bash em um servidor SSH cadastrado e retorna stdout, stderr e código de retorno. ' +
          'RESTRIÇÕES DE SEGURANÇA: comandos destrutivos em nível de sistema (rm -rf /, mkfs, dd, reboot, shutdown) são BLOQUEADOS automaticamente. ' +
          'Comandos interativos (top, vim, less, sudo, mysql) NÃO são suportados — use alternativas não-interativas.',
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Nome do servidor cadastrado no cofre (ex: "mock-server", "prod-web").',
            },
            command: {
              type: 'string',
              description: 'Comando a ser executado remotamente. Máx 8192 caracteres. Exemplos: "systemctl status nginx", "uptime", "docker ps".',
            },
            cwd: {
              type: 'string',
              description: 'Diretório de trabalho onde o comando deve ser executado no servidor. Não pode conter metacaracteres de shell.',
            },
            timeout: {
              type: 'number',
              description: 'Tempo limite em milissegundos (padrão: 60000, máx: 300000).',
            },
          },
          required: ['server', 'command'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'ssh_read_file',
        description: 'Lê o conteúdo de um arquivo de texto no servidor remoto via SFTP. Somente leitura, não modifica nada.',
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Nome do servidor cadastrado.',
            },
            remotePath: {
              type: 'string',
              description: 'Caminho absoluto ou relativo do arquivo remoto.',
            },
            maxBytes: {
              type: 'number',
              description: 'Tamanho máximo permitido em bytes (padrão: 1MB).',
            },
          },
          required: ['server', 'remotePath'],
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'ssh_write_file',
        description: 'Cria ou sobrescreve um arquivo no servidor remoto via SFTP. CUIDADO: sobrescreve o conteúdo existente.',
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Nome do servidor cadastrado.',
            },
            remotePath: {
              type: 'string',
              description: 'Caminho remoto do arquivo a ser gravado.',
            },
            content: {
              type: 'string',
              description: 'Conteúdo textual a ser gravado no arquivo remoto.',
            },
          },
          required: ['server', 'remotePath', 'content'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'ssh_delete_file',
        description:
          'Exclui um arquivo ou pasta no servidor remoto via SFTP/SSH. ' +
          'CUIDADO: com recursive=true, remove diretórios inteiros. Diretórios críticos do sistema são BLOQUEADOS.',
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Nome do servidor cadastrado.',
            },
            remotePath: {
              type: 'string',
              description: 'Caminho do arquivo ou diretório a ser excluído.',
            },
            recursive: {
              type: 'boolean',
              description: 'Se true, remove diretórios recursivamente.',
            },
          },
          required: ['server', 'remotePath'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'ssh_list_dir',
        description: 'Lista arquivos e diretórios em um caminho do servidor remoto via SFTP com tamanhos e permissões. Somente leitura.',
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Nome do servidor cadastrado.',
            },
            remotePath: {
              type: 'string',
              description: 'Caminho do diretório (padrão: ".").',
            },
          },
          required: ['server'],
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'mock_server_start',
        description: 'Inicia o servidor SSH mock local integrado (127.0.0.1:2222) com SFTP e ambiente de testes emulado.',
        inputSchema: {
          type: 'object',
          properties: {
            port: {
              type: 'number',
              description: 'Porta local para escutar (padrão: 2222, mín: 1024).',
            },
          },
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  };
});

// ──────────────────────────────────────────────
// Handlers de cada tool (extraídos para funções)
// ──────────────────────────────────────────────

async function handleVaultStatus() {
  const status = vault.getStatus();
  return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
}

async function handleVaultInit(args) {
  const validated = VaultInitSchema.parse(args);
  const result = vault.initVault(validated.masterPassword, []);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleVaultUnlock(args) {
  const validated = VaultUnlockSchema.parse(args);
  const password = validated?.masterPassword;
  if (!password) {
    throw new Error('Informe a senha mestra para desbloquear o cofre.');
  }
  const result = vault.unlock(password);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleVaultLock() {
  const result = vault.lock();
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleVaultAddServer(args) {
  const validated = VaultAddServerSchema.parse(args);
  const password = validated?.masterPassword;
  if (!password) {
    throw new Error('Informe a senha mestra para autorizar a inclusão/alteração de servidores no cofre.');
  }
  const result = vault.addServer(password, {
    name: validated.name,
    host: validated.host,
    port: validated.port,
    username: validated.username,
    password: validated.password,
    privateKey: validated.privateKey,
    passphrase: validated.passphrase,
    description: validated.description,
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleVaultRemoveServer(args) {
  const validated = VaultRemoveServerSchema.parse(args);
  const password = validated?.masterPassword;
  if (!password) {
    throw new Error('Informe a senha mestra para autorizar a remoção do servidor.');
  }
  const result = vault.removeServer(password, validated.name);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleSshExecute(args) {
  const validated = SshExecuteSchema.parse(args);
  const serverCreds = vault.getServerCredentials(validated.server);
  auditLog('ssh_execute', { server: validated.server, command: validated.command, cwd: validated.cwd });
  const result = await SshClientManager.executeCommand(serverCreds, validated.command, {
    cwd: validated.cwd,
    timeout: validated.timeout,
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleSshReadFile(args) {
  const validated = SshReadFileSchema.parse(args);
  const serverCreds = vault.getServerCredentials(validated.server);
  auditLog('ssh_read_file', { server: validated.server, remotePath: validated.remotePath });
  const result = await SshClientManager.readFile(serverCreds, validated.remotePath, {
    maxBytes: validated.maxBytes,
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleSshWriteFile(args) {
  const validated = SshWriteFileSchema.parse(args);
  const serverCreds = vault.getServerCredentials(validated.server);
  auditLog('ssh_write_file', { server: validated.server, remotePath: validated.remotePath, contentSize: Buffer.byteLength(validated.content, 'utf-8') });
  const result = await SshClientManager.writeFile(serverCreds, validated.remotePath, validated.content);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleSshDeleteFile(args) {
  const validated = SshDeleteFileSchema.parse(args);
  const serverCreds = vault.getServerCredentials(validated.server);
  auditLog('ssh_delete_file', { server: validated.server, remotePath: validated.remotePath, recursive: validated.recursive });
  const result = await SshClientManager.deleteFile(serverCreds, validated.remotePath, {
    recursive: validated.recursive,
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleSshListDir(args) {
  const validated = SshListDirSchema.parse(args);
  const serverCreds = vault.getServerCredentials(validated.server);
  auditLog('ssh_list_dir', { server: validated.server, remotePath: validated.remotePath });
  const result = await SshClientManager.listDirectory(serverCreds, validated.remotePath || '.');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleMockServerStart(args) {
  const validated = MockServerStartSchema.parse(args || {});
  const port = validated.port || 2222;
  if (!activeMockServer) {
    activeMockServer = await startMockServer(port);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Servidor mock SSH iniciado na porta ${port}.`,
          host: '127.0.0.1',
          port,
          user: 'mockuser',
        }, null, 2),
      }],
    };
  } else {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: 'Servidor mock SSH já está em execução.',
          port,
        }, null, 2),
      }],
    };
  }
}

// Mapa de handlers
const TOOL_HANDLERS = {
  vault_status: handleVaultStatus,
  vault_init: handleVaultInit,
  vault_unlock: handleVaultUnlock,
  vault_lock: handleVaultLock,
  vault_add_server: handleVaultAddServer,
  vault_remove_server: handleVaultRemoveServer,
  ssh_execute: handleSshExecute,
  ssh_read_file: handleSshReadFile,
  ssh_write_file: handleSshWriteFile,
  ssh_delete_file: handleSshDeleteFile,
  ssh_list_dir: handleSshListDir,
  mock_server_start: handleMockServerStart,
};

// ──────────────────────────────────────────────
// Handler principal de execução de tools
// ──────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      throw new Error(`Ferramenta desconhecida: ${name}`);
    }
    return await handler(args);
  } catch (err) {
    // Tratamento especial para erros de validação Zod
    let message;
    if (err.name === 'ZodError' && err.issues) {
      message = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    } else {
      message = sanitizeErrorMessage(err.message);
    }

    auditLog(name, { error: message });

    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Erro em ${name}: ${message}`,
      }],
    };
  }
});

// ──────────────────────────────────────────────
// Lifecycle do processo
// ──────────────────────────────────────────────

function gracefulShutdown(signal) {
  console.error(`[MCP SSH Server] Recebido ${signal}. Encerrando...`);
  try {
    vault.lock();
    closeAllConnections();
    if (activeMockServer) {
      activeMockServer.close();
      activeMockServer = null;
    }
  } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[MCP SSH Server] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[MCP SSH Server] Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

// ──────────────────────────────────────────────
// Inicialização
// ──────────────────────────────────────────────

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP SSH Server] Servidor iniciado e aguardando requisições via stdio.');
}

run().catch((err) => {
  console.error('[MCP SSH Server] Erro fatal:', err);
  process.exit(1);
});
