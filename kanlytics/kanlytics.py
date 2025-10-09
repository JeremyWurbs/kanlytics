from typing import List, Dict, Optional, Any
from .github_repository import GitHubRepository
from .github_issue import GitHubIssue
from mindtrace.core.utils import load_ini_as_dict


class Kanlytics:
    """Main class for GitHub repository analytics."""
    
    def __init__(self, repo_url: str, github_token: Optional[str] = None, project_id: Optional[str] = None):
        """
        Initialize Kanlytics with a GitHub repository.
        
        Args:
            repo_url: GitHub repository URL
            github_token: Optional GitHub personal access token. If None, will attempt
                         to auto-detect from config file, git config, environment variables, or GitHub CLI
            project_id: Optional project board ID for status history tracking. If None, will attempt
                        to auto-detect from config file
        """
        self.repository = GitHubRepository(repo_url, github_token)
        
        # Auto-detect project_id from config if not provided
        if project_id is None:
            try:
                from pathlib import Path
                current_dir = Path(__file__).parent
                config_path = current_dir / "config.ini"
                config_dict = load_ini_as_dict(config_path)
                kanlytics_config = config_dict.get('KANLYTICS', {})
                # Try both lowercase and uppercase keys
                project_id = kanlytics_config.get('project_id', '') or kanlytics_config.get('PROJECT_ID', '')
                if not project_id:
                    project_id = None
            except Exception:
                pass
        
        self.project_id = project_id
    
    def has_github_token(self) -> bool:
        """
        Check if a GitHub token is available (either provided or auto-detected).
        
        Returns:
            True if a token is available, False otherwise
        """
        return self.repository.github_token is not None
    
    def get_issues_with_project_history(self, state: str = "all") -> List[GitHubIssue]:
        """
        Get all issues with project board status history if project_id is configured.
        
        Args:
            state: Issue state ('open', 'closed', or 'all')
            
        Returns:
            List of GitHubIssue objects with status history
        """
        issues = self.repository.get_issues(state=state)
        
        if self.project_id:
            for issue in issues:
                issue.status_history = self.repository.get_project_status_history(
                    issue.number, self.project_id
                )
        
        return issues
    
    def analyze_issues(self, state: str = "all") -> Dict[str, Any]:
        """
        Analyze all issues in the repository.
        
        Args:
            state: Issue state to analyze ('open', 'closed', or 'all')
            
        Returns:
            Dictionary with analysis results
        """
        issues = self.get_issues_with_project_history(state=state)
        
        analysis = {
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