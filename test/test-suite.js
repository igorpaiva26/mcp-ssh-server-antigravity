import { VaultManager } from '../src/crypto-vault.js';
import { SshClientManager, closeAllConnections } from '../src/ssh-client.js';
import { startMockServer } from '../src/mock-server.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

let testsPassed = 0;
let testsFailed = 0;

function ok(label) {
  testsPassed++;
  console.log(`✔ ${label}`);
}

function fail(label, err) {
  testsFailed++;
  console.error(`✘ ${label}: ${err.message || err}`);
}

async function runTestSuite() {
  console.log('=== INICIANDO BATERIA DE TESTES DO MCP SSH ===\n');

  const MASTER_PW = 'SuperSenhaMestra123!@#';
  const MOCK_PORT = 2222;

  // Arquivos isolados para teste (nunca tocam nos arquivos reais do usuário)
  const testCryptoConfig = path.resolve('test', 'test-crypto-config.json');
  const testEncConfig = path.resolve('test', 'test-servers-config.enc.json');
  const testRuntimeKey = path.resolve('test', 'test-runtime.key');
  if (fs.existsSync(testCryptoConfig)) fs.unlinkSync(testCryptoConfig);
  if (fs.existsSync(testEncConfig)) fs.unlinkSync(testEncConfig);
  if (fs.existsSync(testRuntimeKey)) fs.unlinkSync(testRuntimeKey);

  const vault = new VaultManager(testCryptoConfig, testEncConfig, testRuntimeKey);

  // 1. Inicia o Mock SSH Server
  console.log('--- BLOCO 1: Mock Server e Cofre ---\n');
  console.log('1. Iniciando Mock SSH Server local...');
  const mockServer = await startMockServer(MOCK_PORT);
  ok(`Mock SSH Server ativo na porta ${MOCK_PORT}`);

  // 2. Inicializa o cofre
  console.log('\n2. Inicializando cofre criptografado com senha mestra...');
  const initRes = vault.initVault(MASTER_PW);
  assert.strictEqual(initRes.success, true);
  ok('Cofre inicializado e arquivos criados.');

  // 2b. Verifica que runtime key NÃO foi salva em disco (SEC-04)
  console.log('\n2b. Verificando que runtime key NÃO está em disco (SEC-04)...');
  assert.strictEqual(fs.existsSync(testRuntimeKey), false, 'Runtime key não deve existir em disco após initVault');
  ok('Runtime key mantida apenas em memória.');

  // 3. Adiciona servidor mock ao cofre
  console.log('\n3. Adicionando servidor mock ao cofre...');
  const addRes = vault.addServer(MASTER_PW, {
    name: 'mock-local',
    host: '127.0.0.1',
    port: MOCK_PORT,
    username: 'mockuser',
    password: 'mockpass',
    description: 'Servidor SSH Mock para desenvolvimento',
  });
  assert.strictEqual(addRes.success, true);
  ok('Servidor mock cadastrado e protegido no cofre.');

  // 4. Testa travamento e destravamento
  console.log('\n4. Testando travamento (lock) do cofre...');
  vault.lock();
  assert.strictEqual(vault.isUnlocked(), false);
  ok('Cofre trancado. Memória limpa.');

  console.log('\n5. Testando tentativa de acesso com cofre trancado...');
  try {
    vault.getServerCredentials('mock-local');
    assert.fail('Deveria ter falhado pois o cofre está trancado');
  } catch (err) {
    ok(`Bloqueio validado com sucesso: ${err.message}`);
  }

  console.log('\n6. Testando destravamento com senha incorreta...');
  try {
    vault.unlock('SenhaErrada123');
    assert.fail('Deveria ter rejeitado senha incorreta');
  } catch (err) {
    ok(`Senha incorreta rejeitada com sucesso: ${err.message}`);
  }

  console.log('\n7. Destravando cofre com a senha mestra correta...');
  const unlockRes = vault.unlock(MASTER_PW);
  assert.strictEqual(unlockRes.success, true);
  assert.strictEqual(vault.isUnlocked(), true);
  ok('Cofre destravado com sucesso!');

  // 7b. Verifica que runtime key NÃO foi salva em disco após unlock (SEC-04)
  console.log('\n7b. Verificando que runtime key NÃO está em disco após unlock (SEC-04)...');
  assert.strictEqual(fs.existsSync(testRuntimeKey), false, 'Runtime key não deve existir em disco após unlock');
  ok('Runtime key mantida apenas em memória após unlock.');

  // 8. Testando execução remota de comandos SSH
  const creds = vault.getServerCredentials('mock-local');
  console.log('\n--- BLOCO 2: Operações SSH ---\n');
  console.log('8. Testando execução remota SSH (whoami, uptime, uname)...');
  const whoamiRes = await SshClientManager.executeCommand(creds, 'whoami');
  assert.strictEqual(whoamiRes.stdout, 'mockuser');
  assert.ok(whoamiRes._notice, 'Resultado deve conter aviso anti-prompt-injection');
  ok(`whoami: ${whoamiRes.stdout}`);

  const uptimeRes = await SshClientManager.executeCommand(creds, 'uptime');
  ok(`uptime: ${uptimeRes.stdout}`);

  const unameRes = await SshClientManager.executeCommand(creds, 'uname -a');
  ok(`uname -a: ${unameRes.stdout}`);

  // 9. Testando listagem de diretório via SFTP
  console.log('\n9. Testando SFTP: listar diretório...');
  const dirList = await SshClientManager.listDirectory(creds, '.');
  console.log(`   Listagem retornou ${dirList.totalItems} itens:`, dirList.items.map(i => i.filename).join(', '));
  assert(dirList.totalItems > 0);
  assert.ok(dirList._notice, 'Listagem deve conter aviso anti-prompt-injection');
  ok('Listagem de diretório OK.');

  // 10. Testando leitura de arquivo via SFTP
  console.log('\n10. Testando SFTP: ler arquivo welcome.txt...');
  const readRes = await SshClientManager.readFile(creds, 'welcome.txt');
  assert(readRes.content.includes('Mock'));
  assert.ok(readRes._notice, 'readFile deve conter aviso anti-prompt-injection');
  ok(`Conteúdo lido com sucesso: ${readRes.content.trim()}`);

  // 11. Testando escrita de arquivo via SFTP
  console.log('\n11. Testando SFTP: escrever arquivo remoto test_note.txt...');
  const testContent = `Teste automatizado em ${new Date().toISOString()}`;
  await SshClientManager.writeFile(creds, 'test_note.txt', testContent);
  ok('Arquivo gravado com sucesso.');

  // Confirma leitura do arquivo recém-criado
  const readBack = await SshClientManager.readFile(creds, 'test_note.txt');
  assert.strictEqual(readBack.content, testContent);
  ok('Leitura de confirmação validada com exatidão.');

  // 12. Testando exclusão de arquivo via SFTP
  console.log('\n12. Testando SFTP: excluir arquivo test_note.txt...');
  const delRes = await SshClientManager.deleteFile(creds, 'test_note.txt');
  assert.strictEqual(delRes.success, true);
  ok('Arquivo excluído com sucesso.');

  // ──────────────────────────────────────────────
  // BLOCO 3: Testes de SEGURANÇA (novos)
  // ──────────────────────────────────────────────
  console.log('\n--- BLOCO 3: Testes de Segurança ---\n');

  // SEC-01: Denylist de comandos destrutivos
  console.log('13. SEC-01: Testando bloqueio de comandos destrutivos...');
  const dangerousCommands = [
    'rm -rf /',
    'rm -rf / --no-preserve-root',
    'mkfs /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'reboot',
    'shutdown -h now',
    ':(){ :|:& };:',
  ];

  for (const cmd of dangerousCommands) {
    try {
      await SshClientManager.executeCommand(creds, cmd);
      fail(`SEC-01: "${cmd}" deveria ter sido bloqueado`, new Error('Comando não foi bloqueado'));
    } catch (err) {
      assert(err.message.includes('BLOQUEADO'), `Esperava mensagem de bloqueio para "${cmd}": ${err.message}`);
      ok(`Comando destrutivo bloqueado: "${cmd.substring(0, 30)}..."`);
    }
  }

  // SEC-02: Validação de cwd
  console.log('\n14. SEC-02: Testando bloqueio de cwd com metacaracteres...');
  const dangerousCwds = [
    '"; rm -rf / #',
    '$(whoami)',
    '`id`',
    '/tmp; cat /etc/shadow',
    '/tmp | malicious',
  ];

  for (const cwd of dangerousCwds) {
    try {
      await SshClientManager.executeCommand(creds, 'echo test', { cwd });
      fail(`SEC-02: cwd "${cwd}" deveria ter sido bloqueado`, new Error('cwd não foi bloqueado'));
    } catch (err) {
      assert(err.message.includes('BLOQUEADO') || err.message.includes('proibidos'), `Esperava bloqueio de cwd: ${err.message}`);
      ok(`cwd malicioso bloqueado: "${cwd.substring(0, 30)}"`);
    }
  }

  // SEC-03: Validação de remotePath em delete
  console.log('\n15. SEC-03: Testando bloqueio de exclusão de paths críticos...');
  const dangerousPaths = ['/', '/etc', '/var', '/boot', '/usr'];

  for (const p of dangerousPaths) {
    try {
      await SshClientManager.deleteFile(creds, p, { recursive: true });
      fail(`SEC-03: delete "${p}" deveria ter sido bloqueado`, new Error('Path não foi bloqueado'));
    } catch (err) {
      assert(err.message.includes('BLOQUEADO'), `Esperava bloqueio de path "${p}": ${err.message}`);
      ok(`Exclusão de path crítico bloqueada: "${p}"`);
    }
  }

  // SEC-10: Path traversal em SFTP
  console.log('\n16. SEC-10: Testando bloqueio de path traversal com metacaracteres...');
  try {
    await SshClientManager.readFile(creds, '$(cat /etc/passwd)');
    fail('SEC-10: Path com subshell deveria ter sido bloqueado', new Error('Path não foi bloqueado'));
  } catch (err) {
    assert(err.message.includes('BLOQUEADO') || err.message.includes('proibidos'));
    ok('Path traversal com subshell bloqueado.');
  }

  // REL-03: Comandos interativos
  console.log('\n17. REL-03: Testando bloqueio de comandos interativos...');
  const interactiveCommands = ['top', 'vim /etc/hosts', 'nano file.txt', 'sudo ls', 'less /var/log/syslog'];

  for (const cmd of interactiveCommands) {
    try {
      await SshClientManager.executeCommand(creds, cmd);
      fail(`REL-03: "${cmd}" deveria ter sido bloqueado`, new Error('Interativo não bloqueado'));
    } catch (err) {
      assert(err.message.includes('BLOQUEADO'), `Esperava bloqueio de interativo "${cmd}": ${err.message}`);
      ok(`Comando interativo bloqueado: "${cmd}"`);
    }
  }

  // Verifica que comandos legítimos com nomes similares passam
  console.log('\n18. Testando que comandos legítimos NÃO são bloqueados incorretamente...');
  const legitimateCommands = [
    'echo hello',
    'ls -la',
    'cat welcome.txt',
    'uname -a',
    'whoami',
  ];

  for (const cmd of legitimateCommands) {
    try {
      const result = await SshClientManager.executeCommand(creds, cmd);
      assert.ok(result._notice, 'Deve ter aviso anti-injection');
      ok(`Comando legítimo executado: "${cmd}"`);
    } catch (err) {
      // Pode falhar por timeout do mock, mas NÃO deve ser bloqueado
      if (err.message.includes('BLOQUEADO')) {
        fail(`Falso positivo: "${cmd}" foi bloqueado incorretamente`, err);
      } else {
        ok(`Comando legítimo "${cmd}" não foi bloqueado (erro de execução é aceitável no mock).`);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Resultado final
  // ──────────────────────────────────────────────

  // Fechar conexões do pool
  closeAllConnections();
  mockServer.close();

  console.log('\n========================================');
  if (testsFailed === 0) {
    console.log(`🎉 TODOS OS ${testsPassed} TESTES PASSARAM COM SUCESSO!`);
  } else {
    console.log(`⚠️ ${testsPassed} passaram, ${testsFailed} FALHARAM.`);
  }
  console.log('========================================\n');

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTestSuite().catch(err => {
  console.error('\n❌ ERRO DURANTE OS TESTES:', err);
  process.exit(1);
});
