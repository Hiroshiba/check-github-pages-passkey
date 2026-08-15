output "managed_environments" {
  description = "Terraform が管理する GitHub Environment"
  value = sort(concat(
    [github_repository_environment.github_pages.environment],
    [for environment in github_repository_environment.reviewed : environment.environment],
  ))
}

output "pages_url" {
  description = "GitHub Pages の公開 URL"
  value       = github_repository_pages.site.html_url
}

output "production_ruleset_id" {
  description = "production ブランチを固定する ruleset ID"
  value       = github_repository_ruleset.production.ruleset_id
}
