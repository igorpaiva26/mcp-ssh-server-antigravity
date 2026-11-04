# 📋 Guia de Configuração das Skills Operacionais (Notebook Corporativo)

Este documento serve como **lembrete e template** para quando você estiver utilizando o Antigravity no seu **notebook corporativo** e quiser ativar as skills de segurança, Nginx, JBoss e rotinas de produção.

---

## 💬 O Prompt que você vai colar para o agente no notebook corporativo

Basta copiar e colar o texto abaixo em uma conversa com o Antigravity na máquina corporativa:

```text
Olá! Estou no meu ambiente corporativo e preciso que você configure as minhas 3 skills operacionais de produção no Antigravity:
1. ssh-safety-guard (backups automáticos com timestamp antes de qualquer alteração, planejamento de rollback, caminhos proibidos/críticos e validações de sintaxe antes de restart).
2. nginx-ops (caminhos padrão do Nginx, análise inteligente de logs de erro como 502/504, validação de vhosts e certs SSL, checagem com nginx -t).
3. jboss-wildfly-ops (caminhos do JBoss/WildFly, standalone/deployments, marcadores .dodeploy e .failed, análise de logs de JVM, OutOfMemory e pools de conexão).

Crie essas skills na minha pasta global do Antigravity (~/.gemini/antigravity/skills/) com as diretrizes descritas no arquivo LEMBRETE_SKILLS_CORPORATIVO.md.
```

---

## 🛠️ Especificação Detalhada das 3 Skills Corporativas

### 1. Skill: `ssh-safety-guard` (Segurança, Backups & Rollback)
* **Objetivo**: Garantir que o agente nunca cause indisponibilidade acidental e tenha sempre como reverter alterações em segundos.
* **Diretrizes Inegociáveis**:
  * **Backup Antes de Gravar**: Antes de alterar qualquer arquivo de configuração ou script, executar:
    ```bash
    cp /caminho/arquivo.conf /caminho/arquivo.conf.bak_$(date +%Y%m%d_%H%M%S)
    ```
  * **Planejamento de Rollback**: Para cada intervenção, ter pronto o comando reverso de restauração caso o serviço não suba ou retorne erro.
  * **Caminhos Protegidos (Nunca Deletar ou Modificar Sem Confirmação Explícita)**:
    * `/etc/shadow`, `/etc/passwd`, `/etc/sudoers`
    * `/boot/`, `/sys/`, `/proc/`
    * `~/.ssh/authorized_keys`, chaves privadas `/etc/ssh/`
    * Diretórios de dados brutos de banco (`/var/lib/mysql`, `/var/lib/postgresql`) sem dump prévio.
  * **Comando de Teste Pré-Restart**: Nunca rodar `systemctl restart` ou `systemctl reload` sem antes validar sintaxe da ferramenta correspondente.

---

### 2. Skill: `nginx-ops` (Diagnóstico e Operação Nginx)
* **Objetivo**: Agilizar análise de requisições, resolução de erros de proxy reverso e SSL.
* **Caminhos Padrão**:
  * Configurações: `/etc/nginx/nginx.conf`, `/etc/nginx/conf.d/`, `/etc/nginx/sites-available/`, `/etc/nginx/sites-enabled/`
  * Logs: `/var/log/nginx/error.log`, `/var/log/nginx/access.log`
  * Certificados: `/etc/letsencrypt/live/` ou `/etc/ssl/certs/`
* **Rotinas Automatizadas**:
  * **Diagnóstico de 502 Bad Gateway**: Checar se a porta upstream (Node, JBoss, PHP-FPM, Python) está escutando com `ss -tulpn | grep <porta>`.
  * **Análise Rápida de Erros**:
    ```bash
    tail -n 30 /var/log/nginx/error.log | grep -E "error|crit|alert|emerg"
    ```
  * **Validação de Sintaxe Obrigatória**:
    ```bash
    nginx -t
    ```

---

### 3. Skill: `jboss-wildfly-ops` (Diagnóstico JBoss / WildFly)
* **Objetivo**: Gerenciar deploys de artefatos `.war` / `.ear`, monitorar logs da JVM e diagnosticar paradas de aplicação.
* **Caminhos Padrão**:
  * Instalação típica: `/opt/jboss/wildfly/`, `/opt/wildfly/` ou `/usr/share/wildfly/`
  * Deploys: `<JBOSS_HOME>/standalone/deployments/`
  * Configuração: `<JBOSS_HOME>/standalone/configuration/standalone.xml`
  * Logs: `<JBOSS_HOME>/standalone/log/server.log`
* **Rotinas Automatizadas**:
  * **Status de Deploy**: Monitorar arquivos de gatilho:
    * `app.war.deployed` (deploy realizado com sucesso)
    * `app.war.failed` (falha no deploy - inspecionar conteúdo do arquivo `.failed` para ver o stacktrace exato)
    * `app.war.dodeploy` (forçar novo deploy)
  * **Diagnóstico de Erros Java Críticos**:
    * Buscar `java.lang.OutOfMemoryError` (Heap Space / Metaspace)
    * Buscar `IJ000453: Unable to get connection for java:/...` (Pool de banco esgotado ou timeout)
    * Buscar `ClassNotFoundException` / `NoClassDefFoundError` (dependências faltando)
  * **Monitoramento de Recursos**:
    ```bash
    ps aux | grep java
    jstat -gc <pid>  # se o JDK estiver instalado
    ```

---

## 📂 Onde essas Skills são salvas no Antigravity?

No notebook corporativo, as skills são salvas em:
```
C:\Users\<seu-usuario>\.gemini\antigravity\skills\<nome-da-skill>\SKILL.md
```
*(ou no Linux/Mac corporativo em `~/.gemini/antigravity/skills/<nome-da-skill>/SKILL.md`)*

O Antigravity detecta automaticamente os arquivos `SKILL.md` e ativa as instruções contextuais assim que você menciona servidores SSH, deploys ou troubleshooting de Nginx/JBoss.
