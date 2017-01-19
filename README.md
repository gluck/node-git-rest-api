# This is not the project you are looking for !

[This one is](https://github.com/Ullink/git-bare-node-rest-api)

# GIT REST API

The aim of the project is to provide a restful Git API over a set of bare repositories.

```shell
# returns all repositories hosted
GET /
  [ "foo.git", "bar.git" ]

# returns all repositories matching regexp
GET /repo/^foo
  [ "foo.git" ]
  
# the real deal comes now:
# executes git grep over matching repositories/path/refspec and return results
GET /repo/^foo/grep/HEAD?q=SOMETHING&path=*.md
  [ {
    "branch": "HEAD",
    "file": "README.cs",
    "line_no": "128",
    "line": "Now this is really SOMETHING",
    "repo": "foo.git"
  } ... ]
```

## Frontend

You can use this service from the [git-grep-client](https://github.com/Ullink/git-grep-client) React UI.

## Install

You can run it manually using `npm run start`, or use [forever](https://www.npmjs.com/package/forever) to keep it running.
