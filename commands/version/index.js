"use strict";

const os = require("os");
const chalk = require("chalk");
const dedent = require("dedent");
const minimatch = require("minimatch");
const pMap = require("p-map");
const pPipe = require("p-pipe");
const pReduce = require("p-reduce");
const pWaterfall = require("p-waterfall");
const semver = require("semver");

const Command = require("@lerna/command");
const ConventionalCommitUtilities = require("@lerna/conventional-commits");
const checkWorkingTree = require("@lerna/check-working-tree");
const PromptUtilities = require("@lerna/prompt");
const output = require("@lerna/output");
const collectUpdates = require("@lerna/collect-updates");
const { createRunner } = require("@lerna/run-lifecycle");
const batchPackages = require("@lerna/batch-packages");
const ValidationError = require("@lerna/validation-error");

const getCurrentBranch = require("./lib/get-current-branch");
const gitAdd = require("./lib/git-add");
const gitCommit = require("./lib/git-commit");
const gitPush = require("./lib/git-push");
const gitTag = require("./lib/git-tag");
const isBehindUpstream = require("./lib/is-behind-upstream");
const remoteBranchExists = require("./lib/remote-branch-exists");
const isBreakingChange = require("./lib/is-breaking-change");
const isAnythingCommitted = require("./lib/is-anything-committed");
const makePromptVersion = require("./lib/prompt-version");

module.exports = factory;

function factory(argv) {
  return new VersionCommand(argv);
}

class VersionCommand extends Command {
  get otherCommandConfigs() {
    // back-compat
    return ["publish"];
  }

  initialize() {
    // Defaults are necessary here because yargs defaults
    // override durable options provided by a config file
    const {
      amend,
      commitHooks = true,
      gitRemote = "origin",
      gitTagVersion = true,
      push = true,
      signGitCommit,
      signGitTag,
      tagVersionPrefix = "v",
    } = this.options;

    this.gitRemote = gitRemote;
    this.tagPrefix = tagVersionPrefix;
    this.commitAndTag = gitTagVersion;
    this.pushToRemote = gitTagVersion && amend !== true && push;
    // never automatically push to remote when amending a commit

    this.gitOpts = {
      amend,
      commitHooks,
      signGitCommit,
      signGitTag,
    };

    // https://docs.npmjs.com/misc/config#save-prefix
    this.savePrefix = this.options.exact ? "" : "^";

    if (!this.project.isIndependent()) {
      this.logger.info("current version", this.project.version);
    }

    // git validation, if enabled, should happen before updates are calculated and versions picked
    if (!isAnythingCommitted(this.execOpts)) {
      throw new ValidationError(
        "ENOCOMMIT",
        "No commits in this repository. Please commit something before using version."
      );
    }

    this.currentBranch = getCurrentBranch(this.execOpts);

    if (this.currentBranch === "HEAD") {
      throw new ValidationError("ENOGIT", "Detached git HEAD, please checkout a branch to choose versions.");
    }

    if (this.pushToRemote && !remoteBranchExists(this.gitRemote, this.currentBranch, this.execOpts)) {
      throw new ValidationError(
        "ENOREMOTEBRANCH",
        dedent`
          Branch '${this.currentBranch}' doesn't exist in remote '${this.gitRemote}'.
          If this is a new branch, please make sure you push it to the remote first.
        `
      );
    }

    if (
      this.options.allowBranch &&
      ![].concat(this.options.allowBranch).some(x => minimatch(this.currentBranch, x))
    ) {
      throw new ValidationError(
        "ENOTALLOWED",
        dedent`
          Branch '${this.currentBranch}' is restricted from versioning due to allowBranch config.
          Please consider the reasons for this restriction before overriding the option.
        `
      );
    }

    if (
      this.commitAndTag &&
      this.pushToRemote &&
      isBehindUpstream(this.gitRemote, this.currentBranch, this.execOpts)
    ) {
      const message = `Local branch '${this.currentBranch}' is behind remote upstream ${this.gitRemote}/${
        this.currentBranch
      }`;

      if (!this.options.ci) {
        // interrupt interactive execution
        throw new ValidationError(
          "EBEHIND",
          dedent`
            ${message}
            Please merge remote changes into '${this.currentBranch}' with 'git pull'
          `
        );
      }

      // CI execution should not error, but warn & exit
      this.logger.warn("EBEHIND", `${message}, exiting`);

      // still exits zero, aka "ok"
      return false;
    }

    this.updates = collectUpdates(
      this.packageGraph.rawPackageList,
      this.packageGraph,
      this.execOpts,
      this.options
    ).filter(node => {
      if (!node.version) {
        // a package may be unversioned only if it is private
        if (node.pkg.private) {
          this.logger.info("version", "Skipping unversioned private package %j", node.name);
        } else {
          throw new ValidationError(
            "ENOVERSION",
            dedent`
              A version field is required in ${node.name}'s package.json file.
              If you wish to keep the package unversioned, it must be made private.
            `
          );
        }
      }

      return !!node.version;
    });

    if (!this.updates.length) {
      this.logger.success(`No changed packages to ${this.composed ? "publish" : "version"}`);

      // still exits zero, aka "ok"
      return false;
    }

    this.runPackageLifecycle = createRunner(this.options);

    // don't execute recursively if run from a poorly-named script
    this.runRootLifecycle = /^(pre|post)?version$/.test(process.env.npm_lifecycle_event)
      ? stage => {
          this.logger.warn("lifecycle", "Skipping root %j because it has already been called", stage);
        }
      : stage => this.runPackageLifecycle(this.project.manifest, stage);

    const tasks = [
      () => this.getVersionsForUpdates(),
      versions => this.setUpdatesForVersions(versions),
      () => this.setBatchUpdates(),
      () => this.confirmVersions(),
    ];

    // amending a commit probably means the working tree is dirty
    if (this.commitAndTag && amend !== true) {
      tasks.unshift(() => checkWorkingTree(this.execOpts));
    } else {
      this.logger.warn("version", "Skipping working tree validation, proceed at your own risk");
    }

    return pWaterfall(tasks);
  }

  execute() {
    const tasks = [() => this.updatePackageVersions()];

    if (this.commitAndTag) {
      tasks.push(() => this.commitAndTagUpdates());
    } else {
      this.logger.info("execute", "Skipping git tag/commit");
    }

    if (this.pushToRemote) {
      tasks.push(() => this.gitPushToRemote());
    } else {
      this.logger.info("execute", "Skipping git push");
    }

    return pWaterfall(tasks).then(() => {
      if (!this.composed) {
        this.logger.success("version", "finished");
      }

      return {
        updates: this.updates,
        updatesVersions: this.updatesVersions,
      };
    });
  }

  getVersionsForUpdates() {
    const independentVersions = this.project.isIndependent();
    const { bump, conventionalCommits, preid } = this.options;
    const repoVersion = bump ? semver.clean(bump) : "";
    const increment = bump && !semver.valid(bump) ? bump : "";
    const isPrerelease = increment.startsWith("pre");

    const getExistingPreId = version => (semver.prerelease(version) || []).shift();
    const resolvePrereleaseId = existingPreid => preid || (isPrerelease && existingPreid) || "alpha";

    const makeGlobalVersionPredicate = nextVersion => {
      this.globalVersion = nextVersion;

      return () => nextVersion;
    };

    // decide the predicate in the conditionals below
    let predicate;

    if (repoVersion) {
      predicate = makeGlobalVersionPredicate(repoVersion);
    } else if (increment && independentVersions) {
      // compute potential prerelease ID for each independent update
      predicate = node => semver.inc(node.version, increment, resolvePrereleaseId(node.prereleaseId));
    } else if (increment) {
      // compute potential prerelease ID once for all fixed updates
      const prereleaseId = getExistingPreId(this.project.version);
      const nextVersion = semver.inc(this.project.version, increment, resolvePrereleaseId(prereleaseId));

      predicate = makeGlobalVersionPredicate(nextVersion);
    } else if (conventionalCommits) {
      // it's a bit weird to have a return here, true
      return this.recommendVersions();
    } else if (independentVersions) {
      // prompt for each independent update with potential prerelease ID
      predicate = makePromptVersion(resolvePrereleaseId);
    } else {
      // prompt once with potential prerelease ID
      const prereleaseId = getExistingPreId(this.project.version);
      const node = { version: this.project.version, prereleaseId };

      predicate = makePromptVersion(resolvePrereleaseId);
      predicate = predicate(node).then(makeGlobalVersionPredicate);
    }

    return Promise.resolve(predicate).then(getVersion => this.reduceVersions(getVersion));
  }

  reduceVersions(getVersion) {
    const iterator = (versionMap, node) =>
      Promise.resolve(getVersion(node)).then(version => versionMap.set(node.name, version));

    return pReduce(this.updates, iterator, new Map());
  }

  recommendVersions() {
    const independentVersions = this.project.isIndependent();
    const { changelogPreset } = this.options;
    const rootPath = this.project.manifest.location;
    const type = independentVersions ? "independent" : "fixed";

    let chain = Promise.resolve();

    if (type === "fixed") {
      chain = chain.then(() => this.setGlobalVersionFloor());
    }

    chain = chain.then(() =>
      this.reduceVersions(node =>
        ConventionalCommitUtilities.recommendVersion(node, type, {
          changelogPreset,
          rootPath,
          tagPrefix: this.tagPrefix,
        })
      )
    );

    if (type === "fixed") {
      chain = chain.then(versions => {
        this.globalVersion = this.setGlobalVersionCeiling(versions);

        return versions;
      });
    }

    return chain;
  }

  setGlobalVersionFloor() {
    const globalVersion = this.project.version;

    for (const { pkg } of this.updates) {
      if (semver.lt(pkg.version, globalVersion)) {
        this.logger.verbose(
          "version",
          `Overriding version of ${pkg.name} from ${pkg.version} to ${globalVersion}`
        );

        pkg.version = globalVersion;
      }
    }
  }

  setGlobalVersionCeiling(versions) {
    let highestVersion = this.project.version;

    versions.forEach(bump => {
      if (semver.gt(bump, highestVersion)) {
        highestVersion = bump;
      }
    });

    versions.forEach((_, name) => versions.set(name, highestVersion));

    return highestVersion;
  }

  setUpdatesForVersions(versions) {
    if (this.project.isIndependent() || versions.size === this.packageGraph.size) {
      // only partial fixed versions need to be checked
      this.updatesVersions = versions;
    } else {
      let hasBreakingChange;

      for (const [name, bump] of versions) {
        hasBreakingChange = hasBreakingChange || isBreakingChange(this.packageGraph.get(name).version, bump);
      }

      if (hasBreakingChange) {
        // _all_ packages need a major version bump whenever _any_ package does
        this.updates = Array.from(this.packageGraph.values());
        this.updatesVersions = new Map(this.updates.map(({ name }) => [name, this.globalVersion]));
      } else {
        this.updatesVersions = versions;
      }
    }
  }

  setBatchUpdates() {
    this.packagesToVersion = this.updates.map(({ pkg }) => pkg);
    this.batchedPackages = batchPackages(this.packagesToVersion, this.options.rejectCycles);
  }

  confirmVersions() {
    const changes = this.packagesToVersion.map(pkg => {
      let line = ` - ${pkg.name}: ${pkg.version} => ${this.updatesVersions.get(pkg.name)}`;
      if (pkg.private) {
        line += ` (${chalk.red("private")})`;
      }
      return line;
    });

    output("");
    output("Changes:");
    output(changes.join(os.EOL));
    output("");

    if (this.options.yes) {
      this.logger.info("auto-confirmed");
      return true;
    }

    // When composed from `lerna publish`, use this opportunity to confirm publishing
    const message = this.composed
      ? "Are you sure you want to publish these packages?"
      : "Are you sure you want to create these versions?";

    return PromptUtilities.confirm(message);
  }

  updatePackageVersions() {
    const { conventionalCommits, changelogPreset, changelog = true } = this.options;
    const independentVersions = this.project.isIndependent();
    const rootPath = this.project.manifest.location;
    const changedFiles = new Set();

    // my kingdom for async await :(
    let chain = Promise.resolve();

    // preversion:  Run BEFORE bumping the package version.
    // version:     Run AFTER bumping the package version, but BEFORE commit.
    // postversion: Run AFTER bumping the package version, and AFTER commit.
    // @see https://docs.npmjs.com/misc/scripts

    // exec preversion lifecycle in root (before all updates)
    chain = chain.then(() => this.runRootLifecycle("preversion"));

    const actions = [
      pkg => this.runPackageLifecycle(pkg, "preversion").then(() => pkg),
      // manifest may be mutated by any previous lifecycle
      pkg => pkg.refresh(),
      pkg => {
        // set new version
        pkg.version = this.updatesVersions.get(pkg.name);

        // update pkg dependencies
        for (const [depName, resolved] of this.packageGraph.get(pkg.name).localDependencies) {
          const depVersion = this.updatesVersions.get(depName);

          if (depVersion && resolved.type !== "directory") {
            // don't overwrite local file: specifiers, they only change during publish
            pkg.updateLocalDependency(resolved, depVersion, this.savePrefix);
          }
        }

        return pkg.serialize().then(() => {
          // commit the updated manifest
          changedFiles.add(pkg.manifestLocation);

          return pkg;
        });
      },
      pkg => this.runPackageLifecycle(pkg, "version").then(() => pkg),
    ];

    if (conventionalCommits && changelog) {
      // we can now generate the Changelog, based on the
      // the updated version that we're about to release.
      const type = independentVersions ? "independent" : "fixed";

      actions.push(pkg =>
        ConventionalCommitUtilities.updateChangelog(pkg, type, {
          changelogPreset,
          rootPath,
          tagPrefix: this.tagPrefix,
        }).then(changelogLocation => {
          // commit the updated changelog
          changedFiles.add(changelogLocation);

          return pkg;
        })
      );
    }

    const mapUpdate = pPipe(actions);

    chain = chain.then(() =>
      pReduce(this.batchedPackages, (_, batch) =>
        // TODO: tune the concurrency?
        pMap(batch, mapUpdate, { concurrency: 100 })
      )
    );

    if (!independentVersions && changelog) {
      this.project.version = this.globalVersion;

      if (conventionalCommits) {
        chain = chain.then(() =>
          ConventionalCommitUtilities.updateChangelog(this.project.manifest, "root", {
            changelogPreset,
            rootPath,
            tagPrefix: this.tagPrefix,
            version: this.globalVersion,
          }).then(changelogLocation => {
            // commit the updated changelog
            changedFiles.add(changelogLocation);
          })
        );
      }

      chain = chain.then(() =>
        this.project.serializeConfig().then(lernaConfigLocation => {
          // commit the version update
          changedFiles.add(lernaConfigLocation);
        })
      );
    }

    // exec version lifecycle in root (after all updates)
    chain = chain.then(() => this.runRootLifecycle("version"));

    if (this.commitAndTag) {
      chain = chain.then(() => gitAdd(Array.from(changedFiles), this.execOpts));
    }

    return chain;
  }

  commitAndTagUpdates() {
    let chain = Promise.resolve();

    if (this.project.isIndependent()) {
      chain = chain.then(() => this.gitCommitAndTagVersionForUpdates());
    } else {
      chain = chain.then(() => this.gitCommitAndTagVersion());
    }

    chain = chain.then(tags => {
      this.tags = tags;
    });

    // run the postversion script for each update
    chain = chain.then(() =>
      pMap(this.packagesToVersion, pkg => this.runPackageLifecycle(pkg, "postversion"))
    );

    // run postversion, if set, in the root directory
    chain = chain.then(() => this.runRootLifecycle("postversion"));

    return chain;
  }

  gitCommitAndTagVersionForUpdates() {
    const tags = this.packagesToVersion.map(pkg => `${pkg.name}@${this.updatesVersions.get(pkg.name)}`);
    const subject = this.options.message || "Publish";
    const message = tags.reduce((msg, tag) => `${msg}${os.EOL} - ${tag}`, `${subject}${os.EOL}`);

    return Promise.resolve()
      .then(() => gitCommit(message, this.gitOpts, this.execOpts))
      .then(() => Promise.all(tags.map(tag => gitTag(tag, this.gitOpts, this.execOpts))))
      .then(() => tags);
  }

  gitCommitAndTagVersion() {
    const version = this.globalVersion;
    const tag = `${this.tagPrefix}${version}`;
    const message = this.options.message
      ? this.options.message.replace(/%s/g, tag).replace(/%v/g, version)
      : tag;

    return Promise.resolve()
      .then(() => gitCommit(message, this.gitOpts, this.execOpts))
      .then(() => gitTag(tag, this.gitOpts, this.execOpts))
      .then(() => [tag]);
  }

  gitPushToRemote() {
    this.logger.info("git", "Pushing tags...");

    return gitPush(this.gitRemote, this.currentBranch, this.execOpts);
  }
}

module.exports.VersionCommand = VersionCommand;
