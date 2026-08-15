import {
  to = github_branch_default.main
  id = local.repository_name
}

import {
  to = github_branch.production
  id = "${local.repository_name}:production:main"
}

import {
  to = github_repository_ruleset.production
  id = "${local.repository_name}:20309630"
}

import {
  to = github_repository_pages.site
  id = local.repository_name
}

import {
  to = github_repository_environment.github_pages
  id = "${local.repository_name}:github-pages"
}

import {
  to = github_repository_environment_deployment_policy.github_pages
  id = "${local.repository_name}:github-pages:56366777"
}
