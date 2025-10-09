import requests
import subprocess
import os
from datetime import datetime
from typing import List, Dict, Optional, Any
from urllib.parse import urlparse
from .github_issue import GitHubIssue
from mindtrace.core.utils import load_ini_as_dict


class GitHubRepository:
    """Class to pull issues from a GitHub repository with associated information."""
    
    def __init__(self, repo_url: str, github_token: Optional[str] = None):
        """
        Initialize with repository URL and optional GitHub token.
        
        Args:
            repo_url: GitHub repository URL (e.g., 'https://github.com/Mindtrace/mindtrace')
            github_token: GitHub personal access token for private repos and project boards.
                         If None, will attempt to auto-detect from git config or environment.
        """
        self.repo_url = repo_url
        self.owner, self.repo = self._parse_repo_url(repo_url)
        self.base_url = f"https://api.github.com/repos/{self.owner}/{self.repo}"
        
        # Auto-detect token if not provided
        self.github_token = github_token or self._detect_github_token()
        
        self.headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "kanlytics/1.0"
        }
        if self.github_token:
            self.headers["Authorization"] = f"token {self.github_token}"
    
    def _parse_repo_url(self, url: str) -> tuple[str, str]:
        """Parse GitHub repository URL to extract owner and repo name."""
        parsed = urlparse(url)
        if parsed.netloc != "github.com":
            raise ValueError("URL must be a GitHub repository")
        
        path_parts = parsed.path.strip("/").split("/")
        if len(path_parts) < 2:
            raise ValueError("Invalid GitHub repository URL format")
        
        return path_parts[0], path_parts[1]
    
    def _detect_github_token(self) -> Optional[str]:
        """
        Auto-detect GitHub token from various sources.
        
        Returns:
            GitHub token if found, None otherwise
        """
        # Try config file first
        token = self._get_token_from_config()
        if token:
            return token
        
        # Try environment variables
        token = self._get_token_from_env()
        if token:
            return token
        
        # Try git config
        token = self._get_token_from_git_config()
        if token:
            return token
        
        # Try GitHub CLI
        token = self._get_token_from_gh_cli()
        if token:
            return token
        
        return None
    
    def _get_token_from_config(self) -> Optional[str]:
        """Get GitHub token from config.ini file."""
        try:
            from pathlib import Path
            # Config file is now in the same directory as this file
            current_dir = Path(__file__).parent
            config_path = current_dir / "config.ini"
            config_dict = load_ini_as_dict(config_path)
            kanlytics_config = config_dict.get('KANLYTICS', {})
            # Try both lowercase and uppercase keys
            token = kanlytics_config.get('github_pat', '') or kanlytics_config.get('GITHUB_PAT', '')
            if token and self._is_valid_token(token):
                return token
        except Exception:
            # Config file not found or invalid - that's okay
            pass
        
        return None
    
    def _get_token_from_env(self) -> Optional[str]:
        """Get GitHub token from environment variables."""
        # Check common environment variable names
        env_vars = [
            'GITHUB_TOKEN',
            'GITHUB_PAT',
            'GITHUB_ACCESS_TOKEN',
            'GH_TOKEN'
        ]
        
        for env_var in env_vars:
            token = os.getenv(env_var)
            if token and self._is_valid_token(token):
                return token
        
        return None
    
    def _get_token_from_git_config(self) -> Optional[str]:
        """Get GitHub token from git configuration."""
        try:
            # Check for GitHub token in git config
            result = subprocess.run(
                ['git', 'config', '--get', 'github.token'],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                token = result.stdout.strip()
                if token and self._is_valid_token(token):
                    return token
            
            # Check for credential helper tokens
            result = subprocess.run(
                ['git', 'config', '--get', 'credential.helper'],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                # Try to get token from credential store
                token = self._get_token_from_credential_store()
                if token and self._is_valid_token(token):
                    return token
        
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError):
            pass
        
        return None
    
    def _get_token_from_gh_cli(self) -> Optional[str]:
        """Get GitHub token from GitHub CLI."""
        try:
            result = subprocess.run(
                ['gh', 'auth', 'token'],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                token = result.stdout.strip()
                if token and self._is_valid_token(token):
                    return token
        
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError):
            pass
        
        return None
    
    def _get_token_from_credential_store(self) -> Optional[str]:
        """Try to get token from git credential store."""
        try:
            # This is a simplified approach - in practice, credential stores
            # are more complex and may require different handling
            result = subprocess.run(
                ['git', 'credential', 'fill'],
                input=f'protocol=https\nhost=github.com\n',
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                # Parse the credential output
                lines = result.stdout.strip().split('\n')
                for line in lines:
                    if line.startswith('password='):
                        token = line.split('=', 1)[1]
                        if self._is_valid_token(token):
                            return token
        
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError):
            pass
        
        return None
    
    def _is_valid_token(self, token: str) -> bool:
        """
        Basic validation of GitHub token format.
        
        Args:
            token: Token string to validate
            
        Returns:
            True if token appears valid, False otherwise
        """
        if not token or len(token) < 10:
            return False
        
        # GitHub tokens are typically 40 characters for classic tokens
        # or start with 'ghp_', 'gho_', 'ghu_', 'ghs_', or 'ghr_' for fine-grained tokens
        if len(token) == 40 and token.isalnum():
            return True
        
        if token.startswith(('ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_')):
            return True
        
        return False
    
    def get_issues(self, state: str = "all", per_page: int = 100) -> List[GitHubIssue]:
        """
        Pull all issues from the repository.
        
        Args:
            state: Issue state ('open', 'closed', or 'all')
            per_page: Number of issues per page (max 100)
            
        Returns:
            List of GitHubIssue objects
        """
        issues = []
        page = 1
        
        while True:
            url = f"{self.base_url}/issues"
            params = {
                "state": state,
                "per_page": per_page,
                "page": page,
                "sort": "created",
                "direction": "desc"
            }
            
            response = requests.get(url, headers=self.headers, params=params)
            response.raise_for_status()
            
            page_issues = response.json()
            if not page_issues:
                break
            
            for issue_data in page_issues:
                # Skip pull requests (they have pull_request field)
                if "pull_request" in issue_data:
                    continue
                
                issue = GitHubIssue(
                    number=issue_data["number"],
                    title=issue_data["title"],
                    body=issue_data.get("body", ""),
                    state=issue_data["state"],
                    created_at=issue_data["created_at"],
                    updated_at=issue_data["updated_at"],
                    closed_at=issue_data.get("closed_at"),
                    assignees=issue_data.get("assignees", []),
                    labels=issue_data.get("labels", []),
                    url=issue_data["html_url"]
                )
                issues.append(issue)
            
            page += 1
        
        return issues
    
    def get_project_status_history(self, issue_number: int, project_id: str) -> List[Dict[str, Any]]:
        """
        Get status history for an issue from a project board using GraphQL API.
        
        Args:
            issue_number: GitHub issue number
            project_id: GitHub project ID
            
        Returns:
            List of status history entries
        """
        if not self.github_token:
            return []
        
        # GraphQL query to get project item history
        query = """
        query($owner: String!, $repo: String!, $issueNumber: Int!, $projectId: String!) {
            repository(owner: $owner, name: $repo) {
                issue(number: $issueNumber) {
                    projectItems(first: 10) {
                        nodes {
                            project {
                                id
                                title
                            }
                            fieldValues(first: 20) {
                                nodes {
                                    ... on ProjectV2ItemFieldSingleSelectValue {
                                        name
                                        field {
                                            ... on ProjectV2FieldCommon {
                                                name
                                            }
                                        }
                                    }
                                    ... on ProjectV2ItemFieldTextValue {
                                        text
                                        field {
                                            ... on ProjectV2FieldCommon {
                                                name
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        """
        
        variables = {
            "owner": self.owner,
            "repo": self.repo,
            "issueNumber": issue_number,
            "projectId": project_id
        }
        
        try:
            response = requests.post(
                "https://api.github.com/graphql",
                headers={
                    **self.headers,
                    "Content-Type": "application/json"
                },
                json={"query": query, "variables": variables}
            )
            response.raise_for_status()
            
            data = response.json()
            if "errors" in data:
                return []
            
            project_items = data.get("data", {}).get("repository", {}).get("issue", {}).get("projectItems", {}).get("nodes", [])
            
            status_history = []
            for item in project_items:
                project = item.get("project", {})
                if project.get("id") == project_id:
                    field_values = item.get("fieldValues", {}).get("nodes", [])
                    for field_value in field_values:
                        if "name" in field_value:  # Single select value
                            status_history.append({
                                "field": field_value.get("field", {}).get("name", "Status"),
                                "value": field_value.get("name"),
                                "timestamp": datetime.now().isoformat()
                            })
                        elif "text" in field_value:  # Text value
                            status_history.append({
                                "field": field_value.get("field", {}).get("name", "Text"),
                                "value": field_value.get("text"),
                                "timestamp": datetime.now().isoformat()
                            })
            
            return status_history
            
        except Exception as e:
            print(f"Error fetching project status history: {e}")
            return []
    
    def get_issue_with_project_history(self, issue_number: int, project_id: Optional[str] = None) -> Optional[GitHubIssue]:
        """
        Get a specific issue with project board status history.
        
        Args:
            issue_number: GitHub issue number
            project_id: Optional project board ID
            
        Returns:
            GitHubIssue with status history if project_id provided
        """
        url = f"{self.base_url}/issues/{issue_number}"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        
        issue_data = response.json()
        
        issue = GitHubIssue(
            number=issue_data["number"],
            title=issue_data["title"],
            body=issue_data.get("body", ""),
            state=issue_data["state"],
            created_at=issue_data["created_at"],
            updated_at=issue_data["updated_at"],
            closed_at=issue_data.get("closed_at"),
            assignees=issue_data.get("assignees", []),
            labels=issue_data.get("labels", []),
            url=issue_data["html_url"]
        )
        
        if project_id:
            issue.status_history = self.get_project_status_history(issue_number, project_id)
        
        return issue
