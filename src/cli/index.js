#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { BmadFederatedKnowledge } = require('../index');
const { ConfigValidator } = require('../schemas/config-validator');
const fs = require('fs-extra');
const path = require('path');
const { registerAddKnowledgeCommand } = require('./add-knowledge-command');
const { registerConnectionCommands } = require('./connection-commands');
const { registerSyncDbCommand } = require('./sync-db-command');
const { flattenRepositoryToXml } = require('../utils/repo-flattener');
const program = new Command();
const bmadFed = new BmadFederatedKnowledge();
const configValidator = new ConfigValidator();

program
  .name('bmad-fed')
  .description('BMAD Federated Knowledge System CLI')
  .version('1.0.0');

/**
 * Initialize command
 */
program
  .command('init')
  .description('Initialize federated knowledge system')
  .option('-c, --config <path>', 'Configuration file path', './.bmad-fks-core/fks-core-config.yaml')
  .option('-f, --force', 'Force initialization even if already exists')
  .action(async (options) => {
    const spinner = ora('Initializing BMAD Federated Knowledge System...').start();
    
    try {
      const configExists = await fs.pathExists(options.config);
      
      if (configExists && !options.force) {
        spinner.stop();
        const { proceed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'proceed',
          message: 'Configuration file already exists. Do you want to upgrade it?',
          default: false
        }]);
        
        if (!proceed) {
          console.log(chalk.yellow('Initialization cancelled.'));
          return;
        }
        
        spinner.start('Upgrading existing configuration...');
      }

      // Generate example configuration
      const exampleConfig = configValidator.generateExampleConfig();
      
      if (configExists && !options.force) {
        // Merge with existing configuration
        const existingConfig = await configValidator.loadConfigFile(options.config);
        const mergedConfig = {
          ...existingConfig,
          bmad_config: {
            ...existingConfig.bmad_config,
            ...exampleConfig.bmad_config,
            federated_knowledge: exampleConfig.bmad_config.federated_knowledge,
            federated_settings: exampleConfig.bmad_config.federated_settings
          }
        };
        await configValidator.saveConfigFile(mergedConfig, options.config);
      } else {
        await configValidator.saveConfigFile(exampleConfig, options.config);
      }

      await bmadFed.initialize();
      
      spinner.succeed(chalk.green('BMAD Federated Knowledge System initialized successfully!'));
      console.log(chalk.blue(`FKS Configuration saved to: ${options.config}`));
      console.log(chalk.blue('Run "bmad-fed status" to check system status.'));
    } catch (error) {
      spinner.fail(chalk.red('Initialization failed'));
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });


program
    .command('build-context')
    .description('Build full context by syncing repos, syncing web sources, syncing database sources, and flattening cache')
    .action(async () => {
      try {
        await bmadFed.initialize();

        // === 1. Sync repos ===
        let spinner = ora('Syncing all repositories...').start();
        const syncResults = await bmadFed.syncAll();
        spinner.succeed(chalk.green(
            `Repos synced: ${syncResults.summary.successful} successful, ${syncResults.summary.failed} failed`
        ));

        let contextEntries = [];
        
        // === 2. Sync database sources ===
        spinner = ora('Syncing all database knowledge sources...').start();

        try {
          const knowledgeSources = bmadFed.dependencyResolver.config.bmad_config.knowledge_sources || {};
          const hasDatabaseSources = Object.values(knowledgeSources).some(source => source.type === 'database');

          if (!hasDatabaseSources) {
            spinner.info(chalk.yellow('No database knowledge sources configured. Skipping database sync.'));
          } else {
            // Use the registered action directly with the expected commander signature.
            const tempProgram = new Command();
            registerSyncDbCommand(tempProgram, bmadFed);
            const syncDbCommand = tempProgram.commands.find(cmd => cmd.name() === 'sync-db');

            if (!syncDbCommand || !syncDbCommand._actionHandler) {
              spinner.info(chalk.yellow('Could not find sync-db command handler, skipping database sync.'));
            } else {
              await syncDbCommand._actionHandler(undefined, { all: true, mock: true });
              spinner.succeed(chalk.green('Database sources sync completed.'));
            }
          }
        } catch (err) {
          console.log(chalk.yellow(`Database sync error: ${err.message}`));
          spinner.warn(chalk.yellow('Database sources sync had errors but continuing.'));
        }

        // === 3. Sync web sources ===
        spinner = ora('Syncing all web knowledge sources...').start();
        const webSources = bmadFed.dependencyResolver.config.bmad_config.knowledge_sources || {};
        for (const [name, config] of Object.entries(webSources)) {
          if (config.type === 'web') {
            try {
              const result = await bmadFed.dependencyResolver.getWeb(name, config);
              if (result.status === 'success') {
                console.log(chalk.green(`✓ Web source "${name}" synced`));

                // Add web source to context entries
                const description = config.metadata?.description || 'No description provided';
                contextEntries.push({
                  name,
                  file: result.filePath || `./.bmad-fks-cache/${name}.pdf`, // Assuming getWeb returns filePath
                  description,
                  type: 'web',
                  url: config.url
                });
              } else {
                console.log(chalk.red(`✗ Failed to sync web source "${name}"`));
              }
            } catch (err) {
              console.log(chalk.red(`✗ Error syncing web source "${name}": ${err.message}`));
            }
          }
        }
        spinner.succeed(chalk.green('Web sources sync completed.'));

        // === 4. Flatten repos + build context.md entries ===
        spinner = ora('Flattening repositories into context files...').start();
        const repos = bmadFed.dependencyResolver.getFederatedRepos();

        for (const [name, config] of repos.entries()) {
          const cachePath = config.local_cache || `./.bmad-fks-cache/${name}`;
          const outputFile = `./.bmad-fks-cache/${name}.xml`;

          console.log(chalk.blue(`\n🔄 Flattening repo "${name}" → ${outputFile}`));

          const result = await flattenRepositoryToXml(cachePath, outputFile);
          console.log(chalk.green(`✓ Flattened ${name} → ${outputFile} (${result.fileCount} files)`));

          // Get description from config if available
          const description = config.metadata?.description || 'No description provided';
          contextEntries.push({
            name,
            file: outputFile,
            description,
            type: 'repo',
            repo: config.repo
          });
        }

        spinner.succeed(chalk.green('Context built successfully for all repos!'));

        // === 4. Write context.md ===
        const contextMd = [
          '# Context Definition File',
          '',
          'This file maps each knowledge source to its file, along with descriptions.',
          ''
        ];

        // Group by type for better organization
        const repoEntries = contextEntries.filter(e => e.type === 'repo');
        const webEntries = contextEntries.filter(e => e.type === 'web');

        if (repoEntries.length > 0) {
          contextMd.push('## Repository Sources');
          contextMd.push('');
          for (const entry of repoEntries) {
            contextMd.push(`### ${entry.name}`);
            contextMd.push(`- **File**: ${entry.file}`);
            contextMd.push(`- **Repository**: ${entry.repo}`);
            contextMd.push(`- **Description**: ${entry.description}`);
            contextMd.push('');
          }
        }

        if (webEntries.length > 0) {
          contextMd.push('## Web Sources');
          contextMd.push('');
          for (const entry of webEntries) {
            contextMd.push(`### ${entry.name}`);
            contextMd.push(`- **File**: ${entry.file}`);
            contextMd.push(`- **URL**: ${entry.url}`);
            contextMd.push(`- **Description**: ${entry.description}`);
            contextMd.push('');
          }
        }

        // Add database sources to context entries
        const dbSources = bmadFed.dependencyResolver.config.bmad_config.knowledge_sources || {};
        const dbEntries = [];

        for (const [name, config] of Object.entries(dbSources)) {
          if (config.type === 'database') {
            const cacheRoot = bmadFed.dependencyResolver.config.bmad_config.federated_settings?.cache_root || './bmad-fks-cache';
            const cachePath = path.join(cacheRoot, 'db-knowledge');
            // Check if PDF or JSON exists
            const pdfPath = path.join(cachePath, `${name}.pdf`);
            const jsonPath = path.join(cachePath, `${name}.json`);
            
            let filePath;
            if (await fs.pathExists(pdfPath)) {
              filePath = pdfPath;
            } else if (await fs.pathExists(jsonPath)) {
              filePath = jsonPath;
            } else {
              filePath = `${cachePath}/${name}.pdf`; // Default path even if not yet created
            }
            
            dbEntries.push({
              name,
              file: filePath,
              description: config.metadata?.description || 'No description provided',
              type: 'database',
              connection: config.connection_ref,
              query: config.query
            });
          }
        }

        if (dbEntries.length > 0) {
          contextMd.push('## Database Sources');
          contextMd.push('');
          for (const entry of dbEntries) {
            contextMd.push(`### ${entry.name}`);
            contextMd.push(`- **File**: ${entry.file}`);
            contextMd.push(`- **Connection**: ${entry.connection}`);
            contextMd.push(`- **Query**: ${entry.query}`);
            contextMd.push(`- **Description**: ${entry.description}`);
            contextMd.push('');
          }
        }

        const contextPath = path.join(process.cwd(), 'context.md');
        await fs.writeFile(contextPath, contextMd.join('\n'), 'utf8');
        console.log(chalk.blue(`\n📄 Context definition written to ${contextPath}`));

      } catch (error) {
        console.error(chalk.red(`Build-context failed: ${error.message}`));
        process.exit(1);
      }
    });

/**
 * Add repository command
 */
program
  .command('add <name>')
  .description('Add a new federated repository')
  .option('-r, --repo <url>', 'Repository URL')
  .option('-b, --branch <branch>', 'Branch name', 'main')
  .option('-p, --priority <number>', 'Priority (0-999)', '0')
  .option('-s, --sync-policy <policy>', 'Sync policy (daily|weekly|on_demand|manual)', 'weekly')
  .option('-c, --cache <path>', 'Local cache path')
  .option('--interactive', 'Interactive mode')
  .action(async (name, options) => {
    try {
      let repoConfig = {};

      if (options.interactive || !options.repo) {
        // Interactive mode
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'repo',
            message: 'Repository URL:',
            default: options.repo,
            validate: (input) => input.trim() !== '' || 'Repository URL is required'
          },
          {
            type: 'input',
            name: 'branch',
            message: 'Branch:',
            default: options.branch || 'main'
          },
          {
            type: 'input',
            name: 'local_cache',
            message: 'Local cache path:',
            default: options.cache || `./.bmad-fks-cache/${name}`
          },
          {
            type: 'list',
            name: 'sync_policy',
            message: 'Sync policy:',
            choices: ['daily', 'weekly', 'on_demand', 'manual'],
            default: options.syncPolicy || 'weekly'
          },
          {
            type: 'number',
            name: 'priority',
            message: 'Priority (0-999):',
            default: parseInt(options.priority) || 0,
            validate: (input) => (input >= 0 && input <= 999) || 'Priority must be between 0 and 999'
          },
          {
            type: 'input',
            name: 'description',
            message: 'Description (optional):'
          }
        ]);

        repoConfig = {
          repo: answers.repo,
          branch: answers.branch,
          local_cache: answers.local_cache,
          sync_policy: answers.sync_policy,
          priority: answers.priority
        };

        if (answers.description) {
          repoConfig.metadata = { description: answers.description };
        }
      } else {
        // Command line mode
        repoConfig = {
          repo: options.repo,
          branch: options.branch,
          local_cache: options.cache || `./.bmad-fks-cache/${name}`,
          sync_policy: options.syncPolicy,
          priority: parseInt(options.priority)
        };
      }

      const spinner = ora(`Adding repository: ${name}`).start();
      
      await bmadFed.initialize();
      await bmadFed.addRepository(name, repoConfig);
      
      spinner.succeed(chalk.green(`Repository "${name}" added successfully!`));
      console.log(chalk.blue('Run "bmad-fed sync" to synchronize all repositories.'));
    } catch (error) {
      console.error(chalk.red(`Failed to add repository: ${error.message}`));
      process.exit(1);
    }
  });

// add-knowledge command moved to add-knowledge-command.js

/**
 * Remove repository command
 */
program
  .command('remove <name>')
  .description('Remove a federated repository')
  .option('-f, --force', 'Force removal without confirmation')
  .action(async (name, options) => {
    try {
      if (!options.force) {
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to remove repository "${name}"?`,
          default: false
        }]);

        if (!confirm) {
          console.log(chalk.yellow('Removal cancelled.'));
          return;
        }
      }

      const spinner = ora(`Removing repository: ${name}`).start();
      
      await bmadFed.initialize();
      await bmadFed.removeRepository(name);
      
      spinner.succeed(chalk.green(`Repository "${name}" removed successfully!`));
    } catch (error) {
      console.error(chalk.red(`Failed to remove repository: ${error.message}`));
      process.exit(1);
    }
  });
program
    .command("sync-web <name>")
    .description("Sync webpage as PDF into cache")
    .action(async (name) => {
      try {
        await bmadFed.initialize();

        if (name) {
          // Sync specific repository
          const spinner = ora(`Syncing repository: ${name}`).start();

          const result = await bmadFed.dependencyResolver.getWeb(
              name,
              bmadFed.dependencyResolver.config.bmad_config.knowledge_sources[name]
          );

          if (result.status === 'success') {
            spinner.succeed(chalk.green(`Wep page "${name}" synced successfully!`));
          } else {
            spinner.fail(chalk.red(`Failed to sync webpage "${name}"`));
            console.error(chalk.red(result.error || 'Unknown error'));
          }
        } else {
          //TODO Sync all pages

        }
      } catch (error) {
        console.error(chalk.red(`Sync failed: ${error.message}`));
        process.exit(1);
      }
    });

/**
 * Sync command
 */
program
  .command('sync [name]')
  .description('Sync federated repositories')
  .option('-f, --force', 'Force sync regardless of policy')
  .option('-p, --parallel', 'Sync repositories in parallel', true)
  .action(async (name, options) => {
    try {
      await bmadFed.initialize();

      if (name) {
        // Sync specific repository
        const spinner = ora(`Syncing repository: ${name}`).start();
        
        const result = await bmadFed.dependencyResolver.syncRepository(
          name,
          bmadFed.dependencyResolver.federatedRepos.get(name)
        );
        
        if (result.status === 'success') {
          spinner.succeed(chalk.green(`Repository "${name}" synced successfully!`));
        } else {
          spinner.fail(chalk.red(`Failed to sync repository "${name}"`));
          console.error(chalk.red(result.error || 'Unknown error'));
        }
      } else {
        // Sync all repositories
        const spinner = ora('Syncing all repositories...').start();
        
        const results = await bmadFed.syncAll();
        
        spinner.succeed(chalk.green(`Sync completed: ${results.summary.successful} successful, ${results.summary.failed} failed`));
        
        // Show detailed results
        for (const [repoName, result] of Object.entries(results.results)) {
          if (result.status === 'success') {
            console.log(chalk.green(`✓ ${repoName}`));
          } else {
            console.log(chalk.red(`✗ ${repoName}: ${result.error}`));
          }
        }
      }
    } catch (error) {
      console.error(chalk.red(`Sync failed: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Status command
 */
program
  .command('status')
  .description('Show status of federated repositories')
  .option('-v, --verbose', 'Show detailed status')
  .action(async (options) => {
    try {
      await bmadFed.initialize();
      
      const status = await bmadFed.getStatus();
      
      console.log(chalk.blue.bold('\n📚 BMAD Federated Knowledge System Status\n'));
      
      // Summary
      console.log(chalk.white.bold('Summary:'));
      console.log(`  Total repositories: ${status.summary.total}`);
      console.log(`  Ready: ${chalk.green(status.summary.ready)}`);
      console.log(`  Syncing: ${chalk.yellow(status.summary.syncing)}`);
      console.log(`  Errors: ${chalk.red(status.summary.error)}`);
      console.log(`  Not synced: ${chalk.gray(status.summary.not_synced)}\n`);

      // Repository details
      if (Object.keys(status.repositories).length > 0) {
        console.log(chalk.white.bold('Repositories:'));
        
        for (const [name, repoStatus] of Object.entries(status.repositories)) {
          const statusColor = repoStatus.status === 'ready' ? 'green' : 
                             repoStatus.status === 'error' ? 'red' : 'yellow';
          
          console.log(`  ${chalk[statusColor]('●')} ${chalk.bold(name)}`);
          console.log(`    Status: ${chalk[statusColor](repoStatus.status)}`);
          console.log(`    Repository: ${repoStatus.config?.repo || 'N/A'}`);
          console.log(`    Branch: ${repoStatus.config?.branch || 'N/A'}`);
          console.log(`    Priority: ${repoStatus.config?.priority || 0}`);
          console.log(`    Last sync: ${repoStatus.lastSync || 'Never'}`);
          
          if (options.verbose && repoStatus.lastCommit) {
            console.log(`    Last commit: ${repoStatus.lastCommit.hash?.substring(0, 8)} - ${repoStatus.lastCommit.message}`);
            console.log(`    Author: ${repoStatus.lastCommit.author}`);
          }
          
          if (repoStatus.error) {
            console.log(`    Error: ${chalk.red(repoStatus.error)}`);
          }
          
          console.log();
        }
      } else {
        console.log(chalk.gray('No federated repositories configured.'));
        console.log(chalk.blue('Run "bmad-fed add <name>" to add a repository.'));
      }
    } catch (error) {
      console.error(chalk.red(`Failed to get status: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * List command
 */
program
  .command('list')
  .description('List all federated repositories')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      await bmadFed.initialize();
      
      const repos = bmadFed.dependencyResolver.getFederatedRepos();
      
      if (options.json) {
        console.log(JSON.stringify(Object.fromEntries(repos), null, 2));
        return;
      }

      if (repos.size === 0) {
        console.log(chalk.gray('No federated repositories configured.'));
        return;
      }

      console.log(chalk.blue.bold('\n📚 Federated Repositories\n'));
      
      for (const [name, config] of repos.entries()) {
        console.log(`${chalk.bold(name)}`);
        console.log(`  Repository: ${config.repo}`);
        console.log(`  Branch: ${config.branch}`);
        console.log(`  Cache: ${config.local_cache}`);
        console.log(`  Priority: ${config.priority}`);
        console.log(`  Sync Policy: ${config.sync_policy}`);
        console.log(`  Status: ${config.status}`);
        console.log();
      }
    } catch (error) {
      console.error(chalk.red(`Failed to list repositories: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Clean command
 */
program
  .command('clean [name]')
  .description('Clean cache for repositories')
  .option('-f, --force', 'Force clean without confirmation')
  .action(async (name, options) => {
    try {
      const message = name ? `clean cache for repository "${name}"` : 'clean all repository caches';
      
      if (!options.force) {
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to ${message}?`,
          default: false
        }]);

        if (!confirm) {
          console.log(chalk.yellow('Clean cancelled.'));
          return;
        }
      }

      const spinner = ora(`Cleaning ${name ? `repository: ${name}` : 'all caches'}`).start();
      
      await bmadFed.initialize();
      await bmadFed.cleanCache(name);
      
      spinner.succeed(chalk.green(`Cache cleaned successfully!`));
    } catch (error) {
      console.error(chalk.red(`Failed to clean cache: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Validate command
 */
program
  .command('validate [config]')
  .description('Validate configuration file')
  .action(async (configPath) => {
    try {
      const path = configPath || './bmad-fks-core/fks-core-config.yaml';
      const spinner = ora(`Validating configuration: ${path}`).start();
      
      const config = await configValidator.validate(path);
      
      spinner.succeed(chalk.green('Configuration is valid!'));
      
      // Show summary
      const federatedRepos = Object.keys(config.bmad_config.federated_knowledge || {});
      if (federatedRepos.length > 0) {
        console.log(chalk.blue(`Found ${federatedRepos.length} federated repositories:`));
        federatedRepos.forEach(name => console.log(`  - ${name}`));
      }
    } catch (error) {
      console.error(chalk.red(`Configuration validation failed: ${error.message}`));
      process.exit(1);
    }
  });

// Register the knowledge command module
registerAddKnowledgeCommand(program, bmadFed);

// Register the connection commands
registerConnectionCommands(program, bmadFed);

// Register the sync-db command
registerSyncDbCommand(program, bmadFed);

// Handle unknown commands
program.on('command:*', () => {
  console.error(chalk.red(`Unknown command: ${program.args.join(' ')}`));
  console.log(chalk.blue('Run "bmad-fed --help" for available commands.'));
  process.exit(1);
});

// Parse command line arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
