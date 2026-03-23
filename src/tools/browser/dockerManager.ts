/**
 * DockerManager: Manages a Docker container running a headed browser
 * inside Xvfb for headless-docker mode.
 *
 * The container runs playwright-core launchServer() with headless:false
 * inside a virtual display, exposing a WebSocket endpoint that the host
 * MCP server connects to via browserType.connect().
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const IMAGE_NAME = 'mcp-pw-xvfb';
const CONTAINER_PREFIX = 'mcp-pw';
const WS_POLL_INTERVAL_MS = 500;
const WS_POLL_TIMEOUT_MS = 60000;

export class DockerManager {
  private containerId: string | undefined;
  private sharedDir: string | undefined;
  private hostPort: number | undefined;

  /**
   * Check that Docker is installed and the daemon is running.
   * Throws a clear error message if not.
   */
  async checkDocker(): Promise<void> {
    try {
      execSync('docker --version', { stdio: 'pipe' });
    } catch {
      throw new Error(
        'Docker is required for --headless-docker mode.\n' +
          'Install Docker Desktop: https://www.docker.com/products/docker-desktop/'
      );
    }

    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    } catch {
      throw new Error(
        'Docker daemon is not running. Start Docker Desktop and try again.'
      );
    }
  }

  /**
   * Build the mcp-pw-xvfb Docker image if it doesn't already exist.
   * Reads playwright version from the host package.json to ensure version match.
   */
  async buildImage(): Promise<void> {
    const playwrightVersion = this.getPlaywrightVersion();
    const imageTag = `${IMAGE_NAME}:${playwrightVersion}`;

    // Check if image already exists
    try {
      execSync(`docker image inspect ${imageTag}`, { stdio: 'pipe' });
      console.error(`[DockerManager] Image ${imageTag} already exists`);
      return;
    } catch {
      // Image doesn't exist, need to build
    }

    console.error(
      `[DockerManager] Building ${imageTag} image (first time only, this may take a minute)...`
    );

    const contextDir = this.getPackageRoot();
    const dockerfile = join(contextDir, 'Dockerfile.xvfb');

    if (!existsSync(dockerfile)) {
      throw new Error(
        `Dockerfile.xvfb not found at ${dockerfile}. Ensure it exists in the package root.`
      );
    }

    return new Promise((resolve, reject) => {
      const buildProc = spawn(
        'docker',
        [
          'build',
          '-f',
          dockerfile,
          '-t',
          imageTag,
          '--build-arg',
          `PLAYWRIGHT_VERSION=${playwrightVersion}`,
          contextDir,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stderr = '';
      buildProc.stderr?.on('data', (data) => {
        const line = data.toString();
        stderr += line;
        // Show build progress
        process.stderr.write(line);
      });

      buildProc.on('close', (code) => {
        if (code === 0) {
          console.error(`[DockerManager] Image ${imageTag} built successfully`);
          resolve();
        } else {
          reject(
            new Error(
              `Failed to build Docker image (exit code ${code}):\n${stderr.slice(-2000)}`
            )
          );
        }
      });

      buildProc.on('error', (err) => {
        reject(new Error(`Failed to spawn docker build: ${err.message}`));
      });
    });
  }

  /**
   * Start the Docker container with the browser server.
   * Returns the WebSocket URL to connect to.
   */
  async start(browserType: string): Promise<string> {
    await this.checkDocker();
    await this.buildImage();

    const playwrightVersion = this.getPlaywrightVersion();
    const imageTag = `${IMAGE_NAME}:${playwrightVersion}`;

    // Create shared directory for WS URL discovery
    this.sharedDir = mkdtempSync(join(tmpdir(), 'mcp-pw-'));

    // Find an available port
    this.hostPort = await this.findAvailablePort();

    const containerName = `${CONTAINER_PREFIX}-${Date.now()}`;

    console.error(
      `[DockerManager] Starting container ${containerName} on port ${this.hostPort}...`
    );

    // Run the container
    const runArgs = [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-p',
      `${this.hostPort}:3000`,
      '-v',
      `${this.sharedDir}:/shared`,
      '-e',
      `BROWSER=${browserType}`,
      '--shm-size=2g',
      imageTag,
    ];

    try {
      const output = execSync(`docker ${runArgs.join(' ')}`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      this.containerId = output.toString().trim().substring(0, 12);
      console.error(
        `[DockerManager] Container ${this.containerId} started`
      );
    } catch (err: any) {
      this.cleanup();
      throw new Error(
        `Failed to start Docker container: ${err.stderr?.toString() || err.message}`
      );
    }

    // Poll for WS URL via shared volume
    const wsUrl = await this.pollForWsUrl();

    // Replace the container's internal address with localhost
    const url = new URL(wsUrl);
    url.hostname = 'localhost';
    url.port = String(this.hostPort);

    console.error(
      `[DockerManager] Browser server ready at ${url.toString()}`
    );

    return url.toString();
  }

  /**
   * Stop the Docker container and clean up.
   */
  async stop(): Promise<void> {
    if (this.containerId) {
      console.error(
        `[DockerManager] Stopping container ${this.containerId}...`
      );
      try {
        execSync(`docker stop ${this.containerId}`, {
          stdio: 'pipe',
          timeout: 15000,
        });
      } catch {
        // Container may already be stopped
        try {
          execSync(`docker rm -f ${this.containerId}`, {
            stdio: 'pipe',
            timeout: 10000,
          });
        } catch {
          // Ignore - container is gone
        }
      }
      this.containerId = undefined;
    }
    this.cleanup();
  }

  /**
   * Poll the shared volume for the WS URL file written by the container.
   */
  private async pollForWsUrl(): Promise<string> {
    const wsUrlFile = join(this.sharedDir!, 'ws-url');
    const startTime = Date.now();

    while (Date.now() - startTime < WS_POLL_TIMEOUT_MS) {
      // Check if container is still running
      if (this.containerId) {
        try {
          const status = execSync(
            `docker inspect -f '{{.State.Running}}' ${this.containerId}`,
            { stdio: 'pipe' }
          )
            .toString()
            .trim();
          if (status !== 'true') {
            const logs = this.getContainerLogs();
            throw new Error(
              `Docker container exited unexpectedly.\nLast logs:\n${logs}`
            );
          }
        } catch (err: any) {
          if (err.message?.includes('exited unexpectedly')) throw err;
          // inspect failed - container might have been removed
          const logs = this.getContainerLogs();
          throw new Error(
            `Docker container disappeared.\nLast logs:\n${logs}`
          );
        }
      }

      // Check for error file (entrypoint writes errors here)
      const errorFile = join(this.sharedDir!, 'error');
      try {
        if (existsSync(errorFile)) {
          const errorContent = readFileSync(errorFile, 'utf-8').trim();
          throw new Error(`Browser server failed to start:\n${errorContent}`);
        }
      } catch (err: any) {
        if (err.message?.includes('Browser server failed')) throw err;
      }

      // Check for WS URL file
      try {
        if (existsSync(wsUrlFile)) {
          const content = readFileSync(wsUrlFile, 'utf-8').trim();
          if (content.startsWith('ws://')) {
            return content;
          }
        }
      } catch {
        // File not ready yet
      }

      await new Promise((r) => setTimeout(r, WS_POLL_INTERVAL_MS));
    }

    // Timeout - get logs for debugging
    const logs = this.getContainerLogs();
    await this.stop();
    throw new Error(
      `Timed out waiting for browser server to start (${WS_POLL_TIMEOUT_MS / 1000}s).\nContainer logs:\n${logs}`
    );
  }

  /**
   * Get the last 20 lines of container logs for error reporting.
   */
  private getContainerLogs(): string {
    if (!this.containerId) return '(no container)';
    try {
      return execSync(`docker logs --tail 20 ${this.containerId}`, {
        stdio: 'pipe',
        timeout: 5000,
      }).toString();
    } catch {
      return '(unable to retrieve logs)';
    }
  }

  /**
   * Find an available TCP port.
   */
  private async findAvailablePort(): Promise<number> {
    const { createServer } = await import('net');
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error('Failed to get port')));
        }
      });
      server.on('error', reject);
    });
  }

  /**
   * Read the playwright version from the host package.json.
   */
  private getPlaywrightVersion(): string {
    const pkgPath = join(this.getPackageRoot(), 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      // Use the pinned playwright version (not patchright)
      const version =
        pkg.dependencies?.playwright ||
        pkg.dependencies?.['playwright-core'] ||
        '1.57.0';
      // Strip semver range prefixes
      return version.replace(/^[\^~>=<]+/, '');
    } catch {
      return '1.57.0';
    }
  }

  /**
   * Resolve the package root directory (where Dockerfile.xvfb lives).
   */
  private getPackageRoot(): string {
    // __dirname equivalent for ESM
    const thisFile = fileURLToPath(import.meta.url);
    // src/tools/browser/dockerManager.ts -> package root (3 levels up from dist/)
    // In compiled form: dist/tools/browser/dockerManager.js
    return resolve(thisFile, '..', '..', '..', '..');
  }

  /**
   * Clean up the shared temp directory.
   */
  private cleanup(): void {
    if (this.sharedDir) {
      try {
        rmSync(this.sharedDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      this.sharedDir = undefined;
    }
  }
}
