const  express = require('express'),
    fs = require('fs'),
    path = require('path'),
    temp = require('temp'),
    Q = require('q'),
    _ = require('lodash'),
    winston = require('winston'),
    dgit = require('./lib/deferred-git'),
    gitParser = require('./lib/git-parser'),
    addressParser = require('./lib/address-parser'),
    dfs = require('./lib/deferred-fs'),
    Rx = require('rx'),
    RxNode = require('rx-node'),
    cors = require('cors'),
    VError = require('verror');

defaultConfig = {
  prefix: '',
  tmpDir: '/tmp/git',
  installMiddleware: false,
};

const spawn = require('child_process').spawn;

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({ level: 'info', timestamp: true }),
  ],
});

var rxSpawn = function(cmd, args, options) {
    var obs =  Rx.Observable.create(function(observer) {
      var remainder = '';
      function dataHandler(data) {
        var str = data.toString();
        var arr = str.split('\n');
        if (remainder != '') {
          arr[0] = remainder + arr[0];
          remainder = '';
        }
        if (!str.endsWith('\n')) {
          remainder = arr[arr.length - 1];
          arr = arr.slice(0, arr.length - 1);
        }
        arr.forEach(function(line) { observer.onNext(line); });
      }

      function errorHandler(err) {
        var newError = new VError(err, `spawn error for ${cmd}`);
        console.error(newError.stack);
        observer.onError(newError);
      }

      function endHandler(code) {
        if (!_.isNumber(code) || code >= 2) {
          var err = new VError(`spawn error: ${cmd} process exited with code ${code}`);
          console.error(err.stack);
        }
        if (remainder != '') {
          observer.onNext(remainder);
          remainder = '';
        }
        observer.onCompleted();
      }

      logger.info(`Running ${cmd} in ${options.cwd} with args: ${args.join(' ')}`);
      var childProcess = spawn(cmd, args, options);

      childProcess.stdout.addListener('data', dataHandler);
      childProcess.stderr.addListener('data', errorHandler);
      childProcess.addListener('close', endHandler);

      return function() {
        childProcess.kill();
      };
    });
    return obs.publish().refCount();
  };

var rxGit = function(repoPath, args) {
  return rxSpawn('git', ['-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.pager=cat'].concat(args), { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] })
      //.flatMap(function(data) { return data.toString().split('\n'); })
      .filter(function(line) { return line.trim() != ''; } );
}

function mergeConfigs(dst, src) {
  /* XXX good enough */
  for (var p in src) {
    if (!src.hasOwnProperty(p) || src[p] === undefined) continue;
    if (dst.hasOwnProperty(p) && dst[p] !== undefined) continue;
    /* A property is not defined -- set the default value */
    dst[p] = src[p];
  }
}

function logResponseBody(req, res, next) {
  var oldWrite = res.write,
      oldEnd = res.end;
  var chunks = [];

  res.write = function (chunk) {
    chunks.push(chunk);
    oldWrite.apply(res, arguments);
  };

  res.end = function (chunk) {
    if (chunk) chunks.push(chunk);
    var body = Buffer.concat(chunks).toString('utf8');
    logger.info(req.path, body);
    oldEnd.apply(res, arguments);
  };

  next();
}

exports.init = function(app, config) {

mergeConfigs(config, defaultConfig);
config.prefix = config.prefix.replace(/\/*$/, '');

if (config.installMiddleware) {
  if (config.verbose) {
    app.use(logResponseBody);
  }
  app.use(express.bodyParser({ uploadDir: '/tmp', keepExtensions: true }));
  app.use(express.methodOverride());
  app.use(express.cookieParser('a-random-string-comes-here'));
  app.use(cors());
}

function prepareGitVars(req, res, next) {
  req.git = {
    workDir: undefined,
    tree: {},
    file: {},
  };
  next();
}

function getWorkdir(req, res, next) {
  var workDir = config.tmpDir;

  dfs.exists(workDir)
    .then(function (exists) { if (!exists) return Q.reject('not exists'); })
    .then(function() {
      req.git.workDir = workDir;
      logger.info('work dir:', req.git.workDir);
      next();
    });
}

function getRepoName(val) {
  var match;
  if (!val) return null;
  match = /^[-._a-z0-9]*$/i.exec(String(val));
  return match ? match[0] : null;
}

function getRepos(req, res, next) {
  var repo = req.params.repos;
  var workDir = req.git.workDir;
  if (repo.startsWith("^")){
    var match = new RegExp(repo);
    dfs.readdir(workDir)
      .then(
        function(repoList) { req.git.trees = repoList.filter(function(dir) { return match.exec(dir); }); next(); },
        function(error) { reg.json(400, { error: error }); });
  } else {
    req.git.trees = [ repo ];
    next();
  }
}

function getRepo(req, res, next) {
  var repo = req.params.repo;
  var repoDir = path.join(req.git.workDir, repo);

  dfs.exists(repoDir).then(function (exists) {
    if (!exists) {
      res.json(400, { error: "Unknown repo: " + repo });
      return;
    }

    req.git.tree.repo = repo;
    req.git.tree.repoDir = repoDir;
    logger.info('repo dir:', req.git.tree.repoDir);
    next();
  });
}

function getFilePath(req, res, next) {
  // Path form: <PREFIX>/repo/<repo>/tree/<path>
  //               0      1     2     3     4
  var pathNoPrefix = req.path.substr(config.prefix.length);
  var filePath = pathNoPrefix.split('/').slice(4).join(path.sep);

  logger.info('path: ', filePath)
  /* get rid of trailing slash */
  filePath = path.normalize(filePath + '/_/..');
  if (filePath === '/') filePath = '';
  req.git.file.path = filePath;
  logger.info('file path:', req.git.file.path);
  next();
}

function getRevision(req, res, next) {
  if (req.query.rev) {
    req.git.file.rev = req.query.rev;
    logger.info('revision:', req.git.file.rev);
  }
  next();
}

app.param('commit', function (req, res, next, val) {
  var match = /^[a-f0-9]{5,40}$/i.exec(String(val));
  if (!match) {
    res.json(400, { error: "Illegal commit name: " + val });
    return;
  }
  next();
});
app.param('repo', function (req, res, next, val) {
  logger.info('repo:', val);
  if (!getRepoName(val)) {
    res.json(400, { error: "Illegal repo name: " + val });
    return;
  }
  next();
});

/* GET /
 *
 * Response:
 *   json: [ (<repo-name>)* ]
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/',
  [prepareGitVars, getWorkdir],
  function(req, res)
{
  var workDir = req.git.workDir;

  logger.info('list repositories');

  dfs.readdir(workDir)
    .then(
      function(repoList) { res.json(repoList); },
      function(error) { reg.json(400, { error: error }); }
    );
});

/* GET /repo/:repo
 *
 * Response:
 *   json: {}
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/repo/:repos',
  [prepareGitVars, getWorkdir, getRepos],
  function(req, res)
{
  var repos = req.git.trees;

  logger.info('get repos:', req.git.trees);

  res.json(200, repos);
});

var parseGitGrep = function(line) {
  var split = line.split(':');
  return { branch: split[0], file: split[1], line_no: split[2], line: split.splice(3).join(':')};
}

var parseGitBranch = function(text) {
  if (row.trim() == '') return;
  var branch = { name: row.slice(2) };
  if(row[0] == '*') branch.current = true;
  return branch;
}

var getBranches = function(repoDir, spec) {
  if (spec[0] == '^') {
    var match = new RegExp(spec);
    return rxGit(repoDir, ['branch', '--list'])
      .map(function(line) { return parseGitBranch(line).name;})
      .filter(function(br) { return match.exec(br); })
      .toArray();
  } else {
    return Rx.Observable.return([spec]);
  }
}

var observeToResponse = function(res) {
  var first = true;
  var replacer = app.get('json replacer');
  var spaces = app.get('json spaces');
  return Rx.Observer.create(function(val) {
      var body = JSON.stringify(val, replacer, spaces);
      first = !res.headersSent;
      if (first) {
        res.status(200).set('Content-Type', 'application/json');
        res.write('[');
      } else {
        res.write(',');
      }
      res.write(body);
    }, function(e) {
      if (res.headersSent) {
        throw e;
      } else {
        res.status(400).json({ error: e });
      }
    }, function() {
      if (first) {
        res.status(200).set('Content-Type', 'application/json');
        res.write('[');
      }
      res.write(']');
      res.end();
    })
}

app.get(config.prefix + '/repo/:repos/grep/:branches',
  [prepareGitVars, getWorkdir, getRepos],
  function(req, res)
{
  var repos = req.git.trees;
  var q    = req.query.q    || '.';
  var file = req.query.path || '*';
  var ignore_case = req.query.ignore_case ? ['-i'] : [];
  var pattern_type = req.query.pattern_type || 'basic';
  Rx.Observable.from(repos)
    .concatMap(function(repo) {
      var repoDir = path.join(req.git.workDir, repo);
      return getBranches(repoDir, req.params.branches)
        .concatMap(function(list) {
          return rxGit(repoDir, ['-c', 'grep.patternType=' + pattern_type, 'grep', '-In'].concat(ignore_case).concat([q]).concat(list).concat(['--', file]))
            .map(function(line) {
                var ret = parseGitGrep(line);
                ret.repo = repo;
                return ret;
            }).onErrorResumeNext(Rx.Observable.empty());
        });
    })
    .subscribe(observeToResponse(res));
});


/* GET /repo/:repo/branch
 *
 * Response:
 *   json: {
 *     [
 *       ({
 *         "name": <branch name>,
 *         "current": (true or false)
 *       })*
 *     ]
 *   }
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/repo/:repo/branch',
  [prepareGitVars, getWorkdir, getRepo],
  function(req, res)
{
  var repoDir = req.git.tree.repoDir;

  logger.info('list branches');

  dgit('branch --list', repoDir, gitParser.parseGitBranches)
    .then(
      function(branches) { res.json(200, branches); },
      function(error) { res.json(400, { error: error }); }
    );
});

/* GET /repo/:repo/show/<path>?rev=<revision>
 *  `rev` -- can be any legal revision
 * 
 * Response:
 *   <file contents>
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/repo/:repo/show/*',
  [prepareGitVars, getWorkdir, getRepo, getFilePath, getRevision],
  function(req, res)
{
  var repoDir = req.git.tree.repoDir;
  var rev = req.git.file.rev || 'HEAD';
  var file = req.git.file.path;

  dgit('show ' + rev + ':' + file, repoDir)
    .then(
      function(data) { res.send(200, data); },
      function(error) { res.json(400, { error: error }); }
    );
});

/* GET /repo/:repo/ls-tree/<path>?rev=<revision>
 *  `rev` -- can be any legal revision
 * 
 * Response:
 *   json: [
 *     ({
 *       "name": <name>,
 *       "mode": <mode>,
 *       "sha1": <sha>,
 *       "type": ("blob" or "tree"),
 *       "contents": (for trees only),
 *     })*
 *   ]
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/repo/:repo/ls-tree/*',
  [prepareGitVars, getWorkdir, getRepo, getFilePath, getRevision],
  function(req, res)
{
  var repoDir = req.git.tree.repoDir;
  var rev = req.git.file.rev || 'HEAD';
  var file = req.git.file.path;

  dgit('ls-tree -tr ' + rev + ' ' + file, repoDir, gitParser.parseLsTree)
    .then(function (obj) {
	if (!obj) return Q.reject('No such file ' + file + ' in ' + rev);
	return obj;
    })
    .then(
      function (obj) { res.json(200, obj); },
      function (error) { res.json(400, { error: error }); }
    );
});

/* GET /repo/:repo/commit/:commit
 * 
 * Response:
 *   json: {
 *     "sha1": <commit sha1 hash string>,
 *     "parents": [ (<parent sha1 hash string>)* ],
 *     "isMerge": <commit is a merge>,
 *     "author": <author>,
 *     "authorDate": <author date>,
 *     "committer": <committer>,
 *     "commitDate": <commit date>,
 *     "message": <commit message>,
 *     "file": [
 *       "action": ("added", "removed" or "changed"),
 *       "path": <file path>
 *     ]
 *   }
 *
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/repo/:repo/commit/:commit',
  [prepareGitVars, getWorkdir, getRepo],
  function(req, res)
{
  var repoDir = req.git.tree.repoDir;
  var commit = req.params.commit;

  logger.info('get commit info: ', commit, ', repoDir:', repoDir);

  dgit('show --decorate=full --pretty=fuller --parents ' + commit, repoDir,
    gitParser.parseGitCommitShow).then(
      function(commit) { res.json(200, commit); },
      function(error) { res.json(500, { error: error }); }
    );
});

/* GET /repo/:repo/log
 * 
 * Response:
 *   json: {
 *   }
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/repo/:repo/log',
  [prepareGitVars, getWorkdir, getRepo],
  function(req, res)
{
  var message = req.body.message;
  var repoDir = req.git.tree.repoDir;

  logger.info('log');

  dgit('log  --decorate=full --pretty=fuller --all --parents', repoDir,
    gitParser.parseGitLog).then(
      function (log) { res.json(200, log); },
      function (error) { res.json(400, { error: error }); }
    );
});

return dgit('--version', '.')
  .then(function(data) {
    logger.warn(' ++++ ', data);
  }, function (err) {
    logger.warn('git version: error:', err);
  })
  .then(function () {
    return dfs.exists(config.tmpDir);
  })
  .then(function (exists) {
    if (exists) return;
    return dfs.mkdirp(config.tmpDir, 0755);
  });
} /* exports.init */
