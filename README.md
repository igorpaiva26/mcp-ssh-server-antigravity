# MCP SSH Server com Cofre Criptografado & Mock SSH Server

Servidor MCP (Model Context Protocol) para conexões SSH e SFTP de alta segurança, projetado especificamente para agentes de IA executarem comandos e manipularem arquivos diretamente nos servidores remotos poupando tokens de contexto.

---

## 🔒 Arquitetura de Segurança

### Criptografia do Cofre
- **AES-256-GCM + PBKDF2** (100.000 iterações SHA-512)
- `servers-config.enc.json`: credenciais criptografadas com Auth Tag
- `crypto-config.json`: salt exclusivo de 32 bytes + hash verificador SHA-256
- Chave derivada mantida **apenas em memória RAM** durante a sessão (nunca persistida em disco)

### Proteções de Execução
- **Denylist de comandos destrutivos**: `rm -rf /`, `mkfs`, `dd`, `reboot`, `shutdown`, fork bombs — bloqueados automaticamente
- **Comandos interativos bloqueados**: `top`, `vim`, `less`, `sudo`, `mysql` — orientação para usar alternativas não-interativas
- **Validação de `cwd`**: metacaracteres de shell (`;`, `` ` ``, `$()`, `|`, `&&`) são rejeitados
- **Validação de paths SFTP**: paths com metacaracteres ou diretórios críticos do sistema são bloqueados para exclusão
- **Truncamento de saída**: stdout/stderr limitados a 512KB por padrão (previne OOM e estouro de contexto do LLM)
- **Anti-prompt-injection**: saídas do servidor são encapsuladas com aviso para o LLM não interpretar como instruções
- **Annotations MCP**: tools marcadas com `readOnlyHint`, `destructiveHint` para que o host MCP aplique políticas

### Pool de Conexões SSH
- Conexões reutilizadas por host (TTL de 60s de inatividade)
- Reduz latência e handshakes desnecessários

### Graceful Shutdown
- `SIGINT`/`SIGTERM` fecham cofre, conexões e mock server
- Handlers para `unhandledRejection` e `uncaughtException`

### Logging de Auditoria
- Cada operação SSH é logada em stderr: timestamp, tool, servidor, comando/path (sem credenciais)

---

## 🛠️ Ferramentas (Tools) do MCP

| Ferramenta | Tipo | Descrição |
| :--- | :--- | :--- |
| `vault_status` | 🔍 Leitura | Status do cofre e servidores cadastrados (sem credenciais). |
| `vault_init` | ⚙️ Config | Inicializa o cofre com uma senha mestra. |
| `vault_unlock` | ⚙️ Config | Desbloqueia o cofre e carrega servidores na memória. |
| `vault_lock` | ⚙️ Config | Limpa a memória RAM e tranca o cofre. |
| `vault_add_server` | ⚙️ Config | Adiciona/atualiza um servidor no cofre. |
| `vault_remove_server` | ⚠️ Destrutivo | Remove um servidor do cofre. |
| `ssh_execute` | ⚠️ Destrutivo | Executa comandos shell no servidor remoto. |
| `ssh_read_file` | 🔍 Leitura | Lê arquivos remotos via SFTP. |
| `ssh_write_file` | ⚠️ Destrutivo | Grava/atualiza arquivos remotos via SFTP. |
| `ssh_delete_file` | ⚠️ Destrutivo | Exclui arquivos ou diretórios remotos. |
| `ssh_list_dir` | 🔍 Leitura | Lista arquivos e diretórios com metadados. |
| `mock_server_start` | ⚙️ Config | Inicia o servidor SSH Mock local para testes. |

---

## 📦 Instalação

```bash
npm install
```

### Requisitos
- Node.js >= 18.0.0
- Dependências: `@modelcontextprotocol/sdk` ^1.32.2, `ssh2` ^1.17.0

---

## 🚀 Uso

### Iniciar como servidor MCP (stdio)
```bash
npm start
# ou
node src/index.js
```

### Configuração no MCP Host (exemplo para Claude Desktop)
```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["caminho/para/src/index.js"]
    }
  }
}
```

### Primeiro uso
1. O LLM chama `vault_init` com uma senha mestra para criar o cofre
2. Depois usa `vault_add_server` para cadastrar servidores SSH
3. Nas sessões seguintes, usa `vault_unlock` para carregar os servidores

Veja [`config.example.json`](config.example.json) para exemplos de configuração de servidores.

---

## 🧪 Servidor Mock SSH Integrado

* **Host**: `127.0.0.1` | **Porta**: `2222`
* **Usuários de teste**: `mockuser` / `mockpass` ou `admin` / `admin123`
* **Raiz emulada**: `./mock_remote_root/`
* Iniciar manualmente: `npm run mock`

---

## 🧪 Testes Automatizados

```bash
npm test
```

A suíte de testes cobre:
- Operações do cofre (init, lock, unlock, add/remove server)
- Operações SSH/SFTP (execute, read, write, delete, list)
- **Testes de segurança**: bloqueio de comandos destrutivos, cwd malicioso, paths críticos, comandos interativos
- Verificação de que a runtime key não persiste em disco
- Verificação de que comandos legítimos não geram falsos positivos

---

## 🔐 Arquivos Sensíveis (NÃO versionar)

Os seguintes arquivos são excluídos pelo `.gitignore` e **nunca devem ser commitados**:

| Arquivo | Conteúdo |
| :--- | :--- |
| `.vault-runtime.key` | Legado — removido automaticamente na v1.1 |
| `servers-config.enc.json` | Servidores cifrados com AES-256-GCM |
| `crypto-config.json` | Salt e hash verificador |
| `.keys/host_rsa_key` | Chave privada do mock server |
