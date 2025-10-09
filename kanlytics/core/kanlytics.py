from typing import List, Dict, Optional, Any, Union
from .github_repository import GitHubRepository
from .github_issue import GitHubIssue
from mindtrace.core.utils import load_ini_as_dict
from urllib.parse import urlparse


class Kanlytics:
    """Main class for GitHub repository and project board analytics."""
    
    def __init__(self, url: str, github_token: Optional[str] = None, project_id: Optional[str] = None):
        """
        Initialize Kanlytics with a GitHub repository or project board URL.
        
        Args:
            url: GitHub repository URL or project board URL
            github_token: Optional GitHub personal access token. If None, will attempt
                         to auto-detect from config file, git config, environment variables, or GitHub CLI
            project_id: Optional project board ID for status history tracking. If None, will attempt
                        to auto-detect from config file
        """
        self.url = url
        self.url_type = self._detect_url_type(url)
        self.github_token = github_token or self._detect_github_token()
        
        # Auto-detect project_id from config if not provided
        if project_id is None:
            project_id = self._detect_project_id()
        
        # For project boards, extract project ID from URL
        if self.url_type == "project_board" and not project_id:
            project_id = self._extract_project_id_from_url(url)
        
        self.project_id = project_id
        
        # Initialize based on URL type
        if self.url_type == "repository":
            self.repository = GitHubRepository(url, self.github_token)
            self.project_repositories = None
        elif self.url_type == "project_board":
            self.repository = None
            self.project_repositories = self._initialize_project_board(url)
        else:
            raise ValueError(f"Unsupported URL type: {url}")
    
    def _detect_url_type(self, url: str) -> str:
        """
        Detect whether the URL is a repository or project board.
        
        Args:
            url: URL to analyze
            
        Returns:
            'repository' or 'project_board'
        """
        parsed = urlparse(url)
        
        if parsed.netloc != "github.com":
            raise ValueError("URL must be from GitHub")
        
        path_parts = parsed.path.strip("/").split("/")
        
        # Project board URLs: /orgs/{org}/projects/{number} or /users/{user}/projects/{number}
        if len(path_parts) >= 4 and path_parts[2] == "projects":
            return "project_board"
        
        # Repository URLs: /{owner}/{repo}
        elif len(path_parts) >= 2:
            return "repository"
        
        else:
            raise ValueError("Invalid GitHub URL format")
    
    def _detect_github_token(self) -> Optional[str]:
        """Auto-detect GitHub token from various sources."""
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
    
    def _detect_project_id(self) -> Optional[str]:
        """Auto-detect project ID from config file."""
        try:
            from pathlib import Path
            current_dir = Path(__file__).parent
            config_path = current_dir / "config.ini"
            config_dict = load_ini_as_dict(config_path)
            kanlytics_config = config_dict.get('KANLYTICS', {})
            project_id = kanlytics_config.get('project_id', '') or kanlytics_config.get('PROJECT_ID', '')
            return project_id if project_id else None
        except Exception:
            return None
    
    def _get_token_from_config(self) -> Optional[str]:
        """Get GitHub token from config.ini file."""
        try:
            from pathlib import Path
            current_dir = Path(__file__).parent
            config_path = current_dir / "config.ini"
            config_dict = load_ini_as_dict(config_path)
            kanlytics_config = config_dict.get('KANLYTICS', {})
            token = kanlytics_config.get('github_pat', '') or kanlytics_config.get('GITHUB_PAT', '')
            if token and self._is_valid_token(token):
                return token
        except Exception:
            pass
        return None
    
    def _get_token_from_env(self) -> Optional[str]:
        """Get GitHub token from environment variables."""
        import os
        env_vars = ['GITHUB_TOKEN', 'GITHUB_PAT', 'GITHUB_ACCESS_TOKEN', 'GH_TOKEN']
        for env_var in env_vars:
            token = os.getenv(env_var)
            if token and self._is_valid_token(token):
                return token
        return None
    
    def _get_token_from_git_config(self) -> Optional[str]:
        """Get GitHub token from git configuration."""
        import subprocess
        try:
            result = subprocess.run(['git', 'config', '--get', 'github.token'], 
                                  capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                token = result.stdout.strip()
                if token and self._is_valid_token(token):
                    return token
        except Exception:
            pass
        return None
    
    def _get_token_from_gh_cli(self) -> Optional[str]:
        """Get GitHub token from GitHub CLI."""
        import subprocess
        try:
            result = subprocess.run(['gh', 'auth', 'token'], 
                                  capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                token = result.stdout.strip()
                if token and self._is_valid_token(token):
                    return token
        except Exception:
            pass
        return None
    
    def _is_valid_token(self, token: str) -> bool:
        """Basic validation of GitHub token format."""
        if not token or len(token) < 10:
            return False
        if len(token) == 40 and token.isalnum():
            return True
        if token.startswith(('ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_')):
            return True
        return False
    
    def _initialize_project_board(self, project_url: str) -> List[GitHubRepository]:
        """
        Initialize project board and get all repositories with issues.
        
        Args:
            project_url: GitHub project board URL
            
        Returns:
            List of GitHubRepository objects for repositories with issues on the board
        """
        # Extract project ID from URL
        project_id = self._extract_project_id_from_url(project_url)
        
        # Get all issues from the project board
        issues_data = self._get_project_board_issues(project_id)
        
        # Group issues by repository
        repo_issues = {}
        for issue_data in issues_data:
            repo_key = f"{issue_data['repository']['owner']['login']}/{issue_data['repository']['name']}"
            if repo_key not in repo_issues:
                repo_issues[repo_key] = []
            repo_issues[repo_key].append(issue_data)
        
        # Create GitHubRepository objects for each repo with issues
        repositories = []
        for repo_key, issues_list in repo_issues.items():
            repo_url = f"https://github.com/{repo_key}"
            repo = GitHubRepository(repo_url, self.github_token)
            repositories.append(repo)
        
        return repositories
    
    def _extract_project_id_from_url(self, project_url: str) -> str:
        """Extract project ID from project board URL by querying GitHub API."""
        parsed = urlparse(project_url)
        path_parts = parsed.path.strip("/").split("/")
        
        if len(path_parts) >= 4 and path_parts[2] == "projects":
            project_number = path_parts[3]
            
            # Get the organization or user from the URL
            if path_parts[0] == "orgs":
                org_name = path_parts[1]
                return self._get_org_project_id(org_name, project_number)
            elif path_parts[0] == "users":
                user_name = path_parts[1]
                return self._get_user_project_id(user_name, project_number)
        
        raise ValueError("Invalid project board URL format")
    
    def _get_org_project_id(self, org_name: str, project_number: str) -> str:
        """Get the actual project ID for an organization project."""
        import requests
        
        query = """
        query($org: String!, $number: Int!) {
            organization(login: $org) {
                projectV2(number: $number) {
                    id
                }
            }
        }
        """
        
        variables = {
            "org": org_name,
            "number": int(project_number)
        }
        
        headers = {
            "Authorization": f"token {self.github_token}",
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            "https://api.github.com/graphql",
            headers=headers,
            json={"query": query, "variables": variables}
        )
        response.raise_for_status()
        
        data = response.json()
        if "errors" in data:
            raise Exception(f"GraphQL errors: {data['errors']}")
        
        project_data = data.get("data", {}).get("organization", {}).get("projectV2")
        if not project_data:
            raise ValueError(f"Project {project_number} not found in organization {org_name}")
        
        return project_data["id"]
    
    def _get_user_project_id(self, user_name: str, project_number: str) -> str:
        """Get the actual project ID for a user project."""
        import requests
        
        query = """
        query($user: String!, $number: Int!) {
            user(login: $user) {
                projectV2(number: $number) {
                    id
                }
            }
        }
        """
        
        variables = {
            "user": user_name,
            "number": int(project_number)
        }
        
        headers = {
            "Authorization": f"token {self.github_token}",
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            "https://api.github.com/graphql",
            headers=headers,
            json={"query": query, "variables": variables}
        )
        response.raise_for_status()
        
        data = response.json()
        if "errors" in data:
            raise Exception(f"GraphQL errors: {data['errors']}")
        
        project_data = data.get("data", {}).get("user", {}).get("projectV2")
        if not project_data:
            raise ValueError(f"Project {project_number} not found for user {user_name}")
        
        return project_data["id"]
    
    def _get_project_board_issues(self, project_id: str) -> List[Dict[str, Any]]:
        """
        Get all issues from a project board using GraphQL API.
        
        Args:
            project_id: GitHub project ID
            
        Returns:
            List of issue data from the project board
        """
        if not self.github_token:
            raise ValueError("GitHub token required for project board access")
        
        import requests
        from tqdm import tqdm
        
        # GraphQL query to get all issues from project board
        query = """
        query($projectId: ID!, $first: Int!, $after: String) {
            node(id: $projectId) {
                ... on ProjectV2 {
                    items(first: $first, after: $after) {
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                        nodes {
                            content {
                                ... on Issue {
                                    id
                                    number
                                    title
                                    body
                                    state
                                    createdAt
                                    updatedAt
                                    closedAt
                                    url
                                    assignees(first: 10) {
                                        nodes {
                                            login
                                        }
                                    }
                                    labels(first: 10) {
                                        nodes {
                                            name
                                        }
                                    }
                                    repository {
                                        name
                                        owner {
                                            login
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
        
        all_issues = []
        after = None
        page_count = 0
        
        # First, get the total count to estimate progress
        print("Fetching project board issues...")
        
        with tqdm(desc="Loading issues", unit="page") as pbar:
            while True:
                variables = {
                    "projectId": project_id,
                    "first": 100,
                    "after": after
                }
                
                headers = {
                    "Authorization": f"token {self.github_token}",
                    "Content-Type": "application/json"
                }
                
                response = requests.post(
                    "https://api.github.com/graphql",
                    headers=headers,
                    json={"query": query, "variables": variables}
                )
                response.raise_for_status()
                
                data = response.json()
                if "errors" in data:
                    raise Exception(f"GraphQL errors: {data['errors']}")
                
                project_data = data.get("data", {}).get("node", {})
                if not project_data:
                    break
                
                items = project_data.get("items", {})
                issues = items.get("nodes", [])
                
                # Filter out non-issue items and extract issue data
                issues_found = 0
                for item in issues:
                    content = item.get("content")
                    if content and "number" in content and "title" in content:
                        # This is an issue - the content is already the issue data
                        all_issues.append(content)
                        issues_found += 1
                
                page_count += 1
                pbar.set_postfix({"Issues": len(all_issues), "Page": page_count})
                pbar.update(1)
                
                page_info = items.get("pageInfo", {})
                if not page_info.get("hasNextPage", False):
                    break
                
                after = page_info.get("endCursor")
        
        return all_issues
    
    def has_github_token(self) -> bool:
        """
        Check if a GitHub token is available (either provided or auto-detected).
        
        Returns:
            True if a token is available, False otherwise
        """
        return self.github_token is not None
    
    def get_issues_with_project_history(self, state: str = "all") -> List[GitHubIssue]:
        """
        Get all issues with project board status history if project_id is configured.
        
        Args:
            state: Issue state ('open', 'closed', or 'all')
            
        Returns:
            List of GitHubIssue objects with status history
        """
        from tqdm import tqdm
        
        if self.url_type == "repository":
            print("Loading issues from repository...")
            return self._get_repository_issues(state)
        elif self.url_type == "project_board":
            print("Loading issues from project board...")
            return self._get_project_board_issues_with_history(state)
        else:
            raise ValueError(f"Unsupported URL type: {self.url_type}")
    
    def _get_repository_issues(self, state: str) -> List[GitHubIssue]:
        """Get issues from a single repository."""
        issues = self.repository.get_issues(state=state)
        
        if self.project_id:
            for issue in issues:
                issue.status_history = self.repository.get_project_status_history(
                    issue.number, self.project_id
                )
        
        return issues
    
    def _get_project_board_issues_with_history(self, state: str) -> List[GitHubIssue]:
        """Get issues from project board across multiple repositories."""
        from tqdm import tqdm
        
        all_issues = []
        
        # Get all issues from the project board directly
        issues_data = self._get_project_board_issues(self.project_id)
        
        print(f"Converting {len(issues_data)} issues to GitHubIssue objects...")
        
        # Convert GraphQL issue data to GitHubIssue objects
        for issue_data in tqdm(issues_data, desc="Processing issues", unit="issue"):
            # Convert GraphQL format to REST API format
            github_issue = self._convert_graphql_to_github_issue(issue_data)
            
            # Filter by state if specified
            if state != "all" and github_issue.state.lower() != state.lower():
                continue
            
            # Add project board status history if project_id is available
            if self.project_id:
                # Get the repository object for this issue
                repo_key = f"{issue_data['repository']['owner']['login']}/{issue_data['repository']['name']}"
                repo_url = f"https://github.com/{repo_key}"
                repo = GitHubRepository(repo_url, self.github_token)
                github_issue.status_history = repo.get_project_status_history(
                    github_issue.number, self.project_id
                )
            
            all_issues.append(github_issue)
        
        return all_issues
    
    def _convert_graphql_to_github_issue(self, issue_data: Dict[str, Any]) -> GitHubIssue:
        """Convert GraphQL issue data to GitHubIssue object."""
        # Convert assignees from GraphQL format to REST format
        assignees = []
        if issue_data.get("assignees", {}).get("nodes"):
            for assignee in issue_data["assignees"]["nodes"]:
                assignees.append({"login": assignee["login"]})
        
        # Convert labels from GraphQL format to REST format
        labels = []
        if issue_data.get("labels", {}).get("nodes"):
            for label in issue_data["labels"]["nodes"]:
                labels.append({"name": label["name"]})
        
        return GitHubIssue(
            number=issue_data["number"],
            title=issue_data["title"],
            body=issue_data.get("body", ""),
            state=issue_data["state"].lower(),
            created_at=issue_data["createdAt"],
            updated_at=issue_data["updatedAt"],
            closed_at=issue_data.get("closedAt"),
            assignees=assignees,
            labels=labels,
            url=issue_data["url"]
        )
    
    def analyze_issues(self, state: str = "all") -> Dict[str, Any]:
        """
        Analyze all issues in the repository or project board.
        
        Args:
            state: Issue state to analyze ('open', 'closed', or 'all')
            
        Returns:
            Dictionary with analysis results
        """
        from tqdm import tqdm
        
        print("Starting analysis...")
        issues = self.get_issues_with_project_history(state=state)
        
        print(f"Analyzing {len(issues)} issues...")
        
        # Analyze issues with progress bar
        with tqdm(total=len(issues), desc="Analyzing issues", unit="issue") as pbar:
            analysis = {
                "url_type": self.url_type,
                "url": self.url,
                "total_issues": len(issues),
                "open_issues": len([i for i in issues if i.state == "open"]),
                "closed_issues": len([i for i in issues if i.state == "closed"]),
                "issues_with_time_estimates": len([i for i in issues if i.time_estimate]),
                "issues_with_assignees": len([i for i in issues if i.assignees]),
                "issues_with_status_history": len([i for i in issues if i.status_history]),
                "time_estimates": [i.time_estimate for i in issues if i.time_estimate],
                "assignee_distribution": self._get_assignee_distribution(issues),
                "status_distribution": self._get_status_distribution(issues),
                "issues": issues
            }
            pbar.update(len(issues))
        
        # Add repository-specific information for project boards
        if self.url_type == "project_board":
            analysis["repositories"] = [repo.repo_url for repo in self.project_repositories]
            analysis["repository_count"] = len(self.project_repositories)
        
        print("Analysis complete!")
        return analysis
    
    def _get_assignee_distribution(self, issues: List[GitHubIssue]) -> Dict[str, int]:
        """Get distribution of issues by assignee."""
        distribution = {}
        for issue in issues:
            if issue.assignees:
                for assignee in issue.assignees:
                    name = assignee.get("login", "Unknown")
                    distribution[name] = distribution.get(name, 0) + 1
            else:
                distribution["Unassigned"] = distribution.get("Unassigned", 0) + 1
        return distribution
    
    def _get_status_distribution(self, issues: List[GitHubIssue]) -> Dict[str, int]:
        """Get distribution of issues by status from project board."""
        distribution = {}
        for issue in issues:
            if issue.status_history:
                # Get the latest status
                latest_status = issue.status_history[-1] if issue.status_history else {}
                status = latest_status.get("value", "Unknown")
                distribution[status] = distribution.get(status, 0) + 1
            else:
                distribution["No Status"] = distribution.get("No Status", 0) + 1
        return distribution