# 🚀 MCP SSH Server (Antigravity / VS Code / Claude)

Servidor MCP (Model Context Protocol) para automação remota via SSH e SFTP com foco em alta segurança, projetado especificamente para agentes de IA (Google Antigravity, VS Code / Cline / Roo, Claude Desktop) gerenciarem e operarem servidores com eficiência.

---

## 💡 Dúvidas Frequentes & Como Funciona a Configuração

### ❓ "Acabei de clonar o repositório, por que não tem o arquivo de servidores (`servers-config.enc.json`)?"
Por **design de segurança absoluto**, o arquivo de servidores **nunca** é enviado para o Git:
* Ele contém (de forma criptografada em AES-256-GCM) os IPs, usuários, senhas ou chaves privadas dos servidores do autor.
* Cada usuário ou máquina deve ter o seu próprio cofre isolado com a sua própria senha mestra.
* O cofre é gerado localmente pelo próprio agente de IA na primeira utilização, conforme o guia passo a passo abaixo.

---

## 🛠️ Guia Passo a Passo: Gerenciando seus Servidores

Você **não precisa editar nenhum arquivo JSON manualmente** (inclusive eles são criptografados). Todo o ciclo de vida dos seus servidores é feito conversando normalmente com o agente de IA no chat do Antigravity/VS Code.

### 1️⃣ Primeiro Acesso: Inicializar o Cofre (Setup Único)
Na primeira vez que você for usar o MCP nesta máquina, o cofre precisa ser criado com uma senha mestra:
* **No Chat com o Agente:**
  > *"Por favor, inicialize o cofre SSH com a minha senha mestra [SuaSenhaSuperSegura123]"*
* **O que o agente executa nos bastidores:**
  Tool `vault_init`:
  ```json
  { "masterPassword": "SuaSenhaSuperSegura123" }
  ```
  *(Isso gera localmente na máquina os arquivos protegidos `crypto-config.json` e `servers-config.enc.json`)*.

---

### 2️⃣ Como Adicionar Novos Servidores
Para cadastrar uma nova máquina (seja com usuário/senha ou chave SSH PEM):
* **No Chat com o Agente:**
  > *"Adicione ao meu cofre SSH o servidor 'web-prod' no IP 192.168.1.50, porta 22, usuário deploy, senha [SenhaDoSSH], descrição 'Servidor Nginx Principal'. A senha mestra do cofre é [SuaSenhaSuperSegura123]."*
* **O que o agente executa:**
  Tool `vault_add_server`:
  ```json
  {
    "masterPassword": "SuaSenhaSuperSegura123",
    "name": "web-prod",
    "host": "192.168.1.50",
    "port": 22,
    "username": "deploy",
    "password": "SenhaDoSSH",
    "description": "Servidor Nginx Principal"
  }
  ```

---

### 3️⃣ Como Editar / Atualizar um Servidor Existente
Precisa mudar a senha de um servidor, trocar a porta ou apontar para um novo IP?
* **O processo é idêntico à adição:** Basta pedir para atualizar usando o **mesmo nome** (`name`):
* **No Chat com o Agente:**
  > *"Atualize o servidor 'web-prod': altere a porta para 2222 e o usuário para admin. A senha mestra é [SuaSenhaSuperSegura123]."*
* **O que o agente executa:**
  Tool `vault_add_server` (com o mesmo `name: "web-prod"`). O cofre reconhece o nome e substitui a configuração antiga de forma atômica.

---

### 4️⃣ Como Deletar um Servidor do Cofre
Quando desativar uma máquina e quiser expurgar do cofre:
* **No Chat com o Agente:**
  > *"Remova o servidor 'web-prod' do meu cofre SSH. A senha mestra é [SuaSenhaSuperSegura123]."*
* **O que o agente executa:**
  Tool `vault_remove_server`:
  ```json
  {
    "masterPassword": "SuaSenhaSuperSegura123",
    "name": "web-prod"
  }
  ```

---

### 5️⃣ Consultar Servidores Cadastrados
A qualquer momento você pode listar quais máquinas estão cadastradas:
* **No Chat com o Agente:**
  > *"Quais servidores estão cadastrados no meu cofre SSH?"*
* **O que o agente executa:**
  Tool `vault_status`. Ela retorna a lista sanitizada (apenas nomes, hosts, portas e tipo de autenticação), **nunca expondo senhas ou chaves privadas**.

---

### 6️⃣ Desbloquear nas Sessões Diárias
Ao reabrir o Antigravity / VS Code em um novo dia de trabalho:
* **No Chat com o Agente:**
  > *"Desbloqueie meu cofre SSH com a senha [SuaSenhaSuperSegura123]"*
* **O que o agente executa:**
  Tool `vault_unlock`. Os dados são decifrados **apenas para a memória RAM** da sessão ativa, garantindo que nada fique descriptografado em disco.

---

## 🔒 Arquitetura de Segurança Implementada

1. **Criptografia Militar (AES-256-GCM + PBKDF2)**:
   * 100.000 iterações de SHA-512 com Salt randômico de 32 bytes e autenticação de integridade por Auth Tag.
   * Chave derivada mantida **estritamente em memória RAM**.
2. **Denylist de Comandos Destrutivos**:
   * O MCP bloqueia automaticamente comandos catastróficos acidentais do LLM: `rm -rf /`, `mkfs`, `dd of=/dev/`, `reboot`, `shutdown`, fork-bombs.
3. **Bloqueio de Comandos Interativos**:
   * Comandos como `top`, `vim`, `less`, `sudo` interativo são rejeitados de imediato para evitar travamento da sessão.
4. **Proteção Anti-Prompt Injection**:
   * Qualquer saída remota (`stdout`/`stderr`) é encapsulada com avisos de integridade e truncada em 512KB para evitar ataques de injeção e estouro de contexto.
5. **Reuso Eficiente (Connection Pool)**:
   * Sessões SSH são mantidas em cache durante comandos sequenciais com auto-fechamento após 60s de inatividade.

---

## 📦 Instalação & Setup no MCP Host

### 1. Clonar e Instalar Dependências
```bash
git clone https://github.com/igorpaiva26/mcp-ssh-server-antigravity.git
cd mcp-ssh-server-antigravity
npm install
```

### 2. Configurar no Antigravity ou VS Code / Claude Desktop
No seu arquivo de configuração MCP (ex: `mcp_settings.json` ou similar):
```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["C:/caminho/completo/mcp-ssh-server-antigravity/src/index.js"]
    }
  }
}
```

---

## 🧪 Testes Automatizados

O repositório inclui uma bateria de testes completa cobrindo criptografia, comandos SSH, SFTP e todas as barreiras de segurança:
```bash
npm test
```
*(45 testes integrados executados com 100% de sucesso)*.
