# 🚀 MCP SSH Server (Antigravity / VS Code / Claude)

Servidor MCP (Model Context Protocol) para automação remota via SSH e SFTP com foco em alta segurança, projetado para que o seu agente de IA faça **absolutamente tudo por você** através do chat.

---

## ⚡ Setup em 1 Clique (Zero Configuração Manual)

Você **não precisa instalar nada na mão, não precisa abrir terminal, nem checar versão de Node**.

Depois de clonar ou baixar este repositório, basta abrir o chat com o seu Agente de IA (Antigravity, VS Code, Cursor ou Claude) e colar a seguinte mensagem:

> 💬 **"Analise este projeto, instale tudo o que precisa e configure tudo de forma 100% automática para mim. Deixe o servidor MCP SSH pronto para uso."**

O próprio agente:
1. Verifica se o Node.js está presente na sua máquina.
2. Instala todas as dependências automaticamente (`npm install`).
3. Executa a suíte de testes de segurança para garantir integridade.
4. Te devolve a configuração exata pronta para ativar o MCP no seu app.

---

## 💬 Como Usar pelo Chat (Comandos em Linguagem Natural)

Você **nunca precisa editar nenhum arquivo de código ou JSON**. Tudo é feito conversando com o agente:

### 1️⃣ Inicializar o Cofre (Primeira Vez)
O cofre é criado vazio e protegido com criptografia militar AES-256 no seu próprio computador. Basta pedir:
> 💬 *"Inicialize meu cofre SSH com a senha mestra [SuaSenhaSuperSegura123]"*

---

### 2️⃣ Cadastrar, Editar ou Deletar Servidores
Converse normalmente com o agente para gerenciar seus servidores:

| O que você quer fazer | O que colar no Chat com o Agente |
| :--- | :--- |
| **Cadastrar servidor (com senha)** | *"Adicione o servidor 'web-prod' no IP 192.168.1.50, porta 22, usuário deploy, senha [SenhaDoSSH], descrição 'Servidor Principal'. Minha senha mestra é [SuaSenhaSuperSegura123]"* |
| **Cadastrar com chave privada (.pem)** | *"Adicione o servidor 'db-prod' no IP 10.0.0.10, usuário ubuntu, usando esta chave privada: [Cole o texto da chave PEM]. Senha mestra: [SuaSenhaSuperSegura123]"* |
| **Editar um servidor existente** | *"Atualize o servidor 'web-prod': mude a porta para 2222 e o usuário para admin. Minha senha mestra é [SuaSenhaSuperSegura123]"* *(o agente atualiza automaticamente)* |
| **Excluir um servidor** | *"Remova o servidor 'web-prod' do meu cofre. Senha mestra: [SuaSenhaSuperSegura123]"* |
| **Ver servidores cadastrados** | *"Quais servidores estão cadastrados no meu cofre SSH?"* *(o agente lista com segurança, sem expor suas senhas)* |
| **Desbloquear no início do dia** | *"Desbloqueie meu cofre SSH com a senha [SuaSenhaSuperSegura123]"* |
| **Executar comandos remotos** | *"Execute `uptime` e `docker ps` no servidor 'web-prod'"* |

---

## 🔒 Arquitetura de Segurança Transparente

* **Privacidade Absoluta**: Nenhuma senha, IP ou credencial sua é versionada no Git.
* **Criptografia Forte**: Dados protegidos com AES-256-GCM + PBKDF2 (100.000 iterações SHA-512). A chave descriptografada permanece apenas na memória RAM enquanto a sessão estiver aberta.
* **Trava contra Desastres**: Comandos destrutivos acidentais como `rm -rf /`, `mkfs`, `dd of=/dev/`, `reboot` e `shutdown` são bloqueados na raiz pelo MCP.
* **Sem Travamentos**: Comandos interativos (`top`, `vim`, `less`, `sudo` com prompt) são interceptados com orientações não-interativas.
* **Proteção contra Prompt Injection**: Saídas de servidores remotos são encapsuladas e truncadas em 512KB para proteger o contexto do LLM.
