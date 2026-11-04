import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const CRYPTO_CONFIG_FILE = path.join(ROOT_DIR, 'crypto-config.json');
const ENCRYPTED_SERVERS_FILE = path.join(ROOT_DIR, 'servers-config.enc.json');
const RUNTIME_KEY_FILE = path.join(ROOT_DIR, '.vault-runtime.key');

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const ITERATIONS = 100000;
const DIGEST = 'sha512';
const IV_LEN = 12;

/**
 * Schema esperado para crypto-config.json.
 * Usado para validação na inicialização.
 */
const REQUIRED_CRYPTO_CONFIG_FIELDS = ['algorithm', 'salt', 'verifierHash', 'iterations', 'keyLength', 'digest'];

export class VaultManager {
  constructor(cryptoConfigFile = CRYPTO_CONFIG_FILE, encryptedServersFile = ENCRYPTED_SERVERS_FILE, runtimeKeyFile = RUNTIME_KEY_FILE) {
    this.cryptoConfigFile = cryptoConfigFile;
    this.encryptedServersFile = encryptedServersFile;
    this.runtimeKeyFile = runtimeKeyFile;
    this.memoryServers = null; // null = locked, array = unlocked
    this.lastUnlockedAt = null;
    this._derivedKey = null; // Chave mantida apenas em memória

    // Tenta carregar automaticamente se a chave de runtime estiver presente (legado)
    this._autoLoadIfAvailable();
  }

  _autoLoadIfAvailable() {
    try {
      if (this.isInitialized() && fs.existsSync(this.runtimeKeyFile)) {
        const keyHex = fs.readFileSync(this.runtimeKeyFile, 'utf-8').trim();
        const key = Buffer.from(keyHex, 'hex');

        // Valida o config antes de tentar decifrar
        this._validateCryptoConfig();

        this._decryptWithKey(key);
        this._derivedKey = key;

        // Remove o arquivo de runtime key do disco após carregar (migração SEC-04)
        try { fs.unlinkSync(this.runtimeKeyFile); } catch (_) {}

        console.error('[Vault] Auto-load bem-sucedido. Chave de runtime removida do disco por segurança.');
      }
    } catch (err) {
      // Falha silenciosa no autoload; cofre permanece bloqueado até unlock
      console.error(`[Vault] Auto-load falhou (cofre permanece bloqueado): ${err.message}`);
    }
  }

  /**
   * Valida o schema do crypto-config.json.
   * @throws {Error} se o arquivo estiver corrompido ou com campos faltantes
   */
  _validateCryptoConfig() {
    if (!fs.existsSync(this.cryptoConfigFile)) {
      throw new Error('Arquivo crypto-config.json não encontrado.');
    }

    let config;
    try {
      config = JSON.parse(fs.readFileSync(this.cryptoConfigFile, 'utf-8'));
    } catch (parseErr) {
      throw new Error(`crypto-config.json está corrompido (JSON inválido): ${parseErr.message}`);
    }

    for (const field of REQUIRED_CRYPTO_CONFIG_FIELDS) {
      if (!(field in config)) {
        throw new Error(`crypto-config.json: campo obrigatório "${field}" está ausente.`);
      }
    }

    if (typeof config.salt !== 'string' || config.salt.length < 32) {
      throw new Error('crypto-config.json: salt inválido (deve ser hex com pelo menos 32 caracteres).');
    }

    if (typeof config.verifierHash !== 'string' || config.verifierHash.length !== 64) {
      throw new Error('crypto-config.json: verifierHash inválido (deve ser SHA-256 hex de 64 caracteres).');
    }

    return config;
  }

  isInitialized() {
    return fs.existsSync(this.cryptoConfigFile) && fs.existsSync(this.encryptedServersFile);
  }

  isUnlocked() {
    return this.memoryServers !== null;
  }

  /**
   * Deriva a chave criptográfica a partir da senha mestra e do salt
   */
  _deriveKey(masterPassword, saltHex) {
    const salt = Buffer.from(saltHex, 'hex');
    return crypto.pbkdf2Sync(masterPassword, salt, ITERATIONS, KEY_LEN, DIGEST);
  }

  /**
   * Hash para verificar se a senha é válida sem tentar decifrar
   */
  _computeVerifier(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Inicializa o cofre pela primeira vez com a senha mestra fornecida
   */
  initVault(masterPassword, initialServers = []) {
    if (this.isInitialized()) {
      throw new Error('O cofre já está inicializado. Use vault_unlock para desbloquear.');
    }

    if (!masterPassword || typeof masterPassword !== 'string' || masterPassword.length < 8) {
      throw new Error('A senha mestra deve ter pelo menos 8 caracteres.');
    }

    const salt = crypto.randomBytes(32).toString('hex');
    const key = this._deriveKey(masterPassword, salt);
    const verifierHash = this._computeVerifier(key);

    const cryptoConfig = {
      algorithm: ALGORITHM,
      iterations: ITERATIONS,
      keyLength: KEY_LEN,
      digest: DIGEST,
      salt: salt,
      verifierHash: verifierHash,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(this.cryptoConfigFile, JSON.stringify(cryptoConfig, null, 2), 'utf-8');

    // Criptografa lista inicial
    this._encryptAndSaveServers(key, initialServers);

    // Mantém a chave APENAS em memória (SEC-04)
    this._derivedKey = key;
    this.memoryServers = initialServers;
    this.lastUnlockedAt = new Date().toISOString();

    return {
      success: true,
      message: 'Cofre inicializado e desbloqueado com sucesso na memória.',
      serverCount: initialServers.length,
    };
  }

  /**
   * Valida a senha mestra contra o hash de verificação
   */
  _verifyPassword(masterPassword) {
    if (!this.isInitialized()) {
      throw new Error('Cofre não inicializado. Execute vault_init primeiro.');
    }

    const config = this._validateCryptoConfig();
    const key = this._deriveKey(masterPassword, config.salt);
    const verifier = this._computeVerifier(key);

    if (verifier !== config.verifierHash) {
      throw new Error('Senha mestra incorreta.');
    }

    return key;
  }

  _decryptWithKey(key) {
    const rawData = JSON.parse(fs.readFileSync(this.encryptedServersFile, 'utf-8'));
    const iv = Buffer.from(rawData.iv, 'hex');
    const authTag = Buffer.from(rawData.authTag, 'hex');
    const encryptedData = Buffer.from(rawData.data, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, null, 'utf-8');
    decrypted += decipher.final('utf-8');

    const servers = JSON.parse(decrypted);
    this.memoryServers = Array.isArray(servers) ? servers : [];
    this.lastUnlockedAt = new Date().toISOString();
  }

  /**
   * Descriptografa o arquivo e joga na memória RAM
   */
  unlock(masterPassword) {
    const key = this._verifyPassword(masterPassword);
    this._decryptWithKey(key);

    // Mantém a chave APENAS em memória (SEC-04)
    this._derivedKey = key;

    // Remove arquivo legado de runtime key se existir
    if (fs.existsSync(this.runtimeKeyFile)) {
      try { fs.unlinkSync(this.runtimeKeyFile); } catch (_) {}
    }

    return {
      success: true,
      message: 'Cofre desbloqueado com sucesso! Servidores carregados na memória da sessão.',
      servers: this.listServersSummary(),
    };
  }

  /**
   * Bloqueia o cofre limpando a memória RAM
   */
  lock() {
    this.memoryServers = null;
    this.lastUnlockedAt = null;
    this._derivedKey = null;

    // Remove arquivo legado de runtime key se existir
    if (fs.existsSync(this.runtimeKeyFile)) {
      try { fs.unlinkSync(this.runtimeKeyFile); } catch (_) {}
    }

    return {
      success: true,
      message: 'Cofre trancado. Credenciais foram removidas da memória RAM.',
    };
  }

  /**
   * Criptografa o payload e salva em disco
   */
  _encryptAndSaveServers(key, servers) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const jsonString = JSON.stringify(servers, null, 2);
    let encrypted = cipher.update(jsonString, 'utf-8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    const payload = {
      iv: iv.toString('hex'),
      authTag: authTag,
      data: encrypted,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(this.encryptedServersFile, JSON.stringify(payload, null, 2), 'utf-8');
  }

  /**
   * Adiciona ou atualiza um servidor no cofre
   */
  addServer(masterPassword, serverConfig) {
    const key = this._verifyPassword(masterPassword);

    if (!serverConfig.name) {
      throw new Error('O campo "name" é obrigatório para identificar o servidor.');
    }
    if (!serverConfig.host) {
      throw new Error('O campo "host" (IP ou hostname) é obrigatório.');
    }

    // Se a memória não estiver carregada, carrega agora
    if (!this.memoryServers) {
      this._decryptWithKey(key);
    }

    const normalizedConfig = {
      name: serverConfig.name.trim(),
      host: serverConfig.host.trim(),
      port: Number(serverConfig.port) || 22,
      username: serverConfig.username || 'root',
      password: serverConfig.password || null,
      privateKey: serverConfig.privateKey || null,
      passphrase: serverConfig.passphrase || null,
      description: serverConfig.description || '',
      updatedAt: new Date().toISOString(),
    };

    const existingIndex = this.memoryServers.findIndex(s => s.name.toLowerCase() === normalizedConfig.name.toLowerCase());
    if (existingIndex >= 0) {
      this.memoryServers[existingIndex] = normalizedConfig;
    } else {
      this.memoryServers.push(normalizedConfig);
    }

    this._encryptAndSaveServers(key, this.memoryServers);

    // Mantém chave apenas em memória (SEC-04)
    this._derivedKey = key;

    return {
      success: true,
      message: `Servidor "${normalizedConfig.name}" salvo com sucesso no cofre criptografado.`,
      servers: this.listServersSummary(),
    };
  }

  /**
   * Remove um servidor pelo nome
   */
  removeServer(masterPassword, serverName) {
    const key = this._verifyPassword(masterPassword);

    if (!this.memoryServers) {
      this._decryptWithKey(key);
    }

    const initialLength = this.memoryServers.length;
    this.memoryServers = this.memoryServers.filter(s => s.name.toLowerCase() !== serverName.trim().toLowerCase());

    if (this.memoryServers.length === initialLength) {
      throw new Error(`Servidor "${serverName}" não encontrado no cofre.`);
    }

    this._encryptAndSaveServers(key, this.memoryServers);

    // Mantém chave apenas em memória (SEC-04)
    this._derivedKey = key;

    return {
      success: true,
      message: `Servidor "${serverName}" removido com sucesso do cofre.`,
      servers: this.listServersSummary(),
    };
  }

  /**
   * Retorna os servidores em formato sanitizado (sem expor senhas/chaves privadas)
   */
  listServersSummary() {
    if (!this.isUnlocked()) {
      return [];
    }

    return this.memoryServers.map(s => ({
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      authType: s.privateKey ? 'privateKey' : (s.password ? 'password' : 'none'),
      description: s.description || '',
    }));
  }

  /**
   * Busca as credenciais completas de um servidor da memória
   */
  getServerCredentials(serverName) {
    if (!this.isUnlocked()) {
      throw new Error(
        'O cofre está trancado. Use a ferramenta "vault_unlock" informando a senha mestra para carregar os servidores na memória da sessão.'
      );
    }

    const server = this.memoryServers.find(s => s.name.toLowerCase() === serverName.trim().toLowerCase());
    if (!server) {
      const available = this.memoryServers.map(s => s.name).join(', ') || 'Nenhum servidor cadastrado';
      throw new Error(`Servidor "${serverName}" não encontrado no cofre. Disponíveis: ${available}`);
    }

    return server;
  }

  /**
   * Status geral do cofre
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized(),
      isUnlocked: this.isUnlocked(),
      lastUnlockedAt: this.lastUnlockedAt,
      serverCount: this.isUnlocked() ? this.memoryServers.length : null,
      servers: this.listServersSummary(),
    };
  }
}

export const vault = new VaultManager();
