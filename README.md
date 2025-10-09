# Kanlytics

A Python library for analyzing GitHub repository issues with advanced features including time estimation extraction, project board status tracking, and assignee analysis.

## Features

- **Repository Analysis**: Pull all issues from any GitHub repository
- **Time Estimation**: Automatically extract time estimates from issue descriptions using pattern matching
- **Project Board Integration**: Track issue status history from GitHub project boards (requires authentication)
- **Assignee Tracking**: Analyze issue distribution by assignee
- **Status History**: Monitor issue progression through project board statuses
- **Configurable**: Works with both public and private repositories

## Installation

```bash
pip install -r requirements.txt
```

## Quick Start

### Basic Usage

```python
from kanlytics import Kanlytics

# Analyze a public repository
kanlytics = Kanlytics("https://github.com/Mindtrace/mindtrace")
analysis = kanlytics.analyze_issues()

print(f"Total issues: {analysis['total_issues']}")
print(f"Open issues: {analysis['open_issues']}")
print(f"Issues with time estimates: {analysis['issues_with_time_estimates']}")
```

### Advanced Usage with Project Boards

```python
# For private repositories and project board access
kanlytics = Kanlytics(
    "https://github.com/Mindtrace/mindtrace",
    github_token="your_github_token",
    project_id="your_project_id"
)

# Get issues with project board status history
issues = kanlytics.get_issues_with_project_history()
analysis = kanlytics.analyze_issues()
```

## API Reference

### Kanlytics Class

Main class for repository analysis.

#### Constructor
```python
Kanlytics(repo_url: str, github_token: Optional[str] = None, project_id: Optional[str] = None)
```

- `repo_url`: GitHub repository URL (e.g., 'https://github.com/owner/repo')
- `github_token`: GitHub personal access token for private repos and project boards
- `project_id`: GitHub project board ID for status history tracking

#### Methods

- `analyze_issues(state: str = "all")`: Analyze all issues and return comprehensive statistics
- `get_issues_with_project_history(state: str = "all")`: Get issues with project board status history

### GitHubIssue Class

Represents a GitHub issue with all associated information.

#### Attributes
- `number`: Issue number
- `title`: Issue title
- `body`: Issue description
- `state`: Issue state (open/closed)
- `created_at`: Creation timestamp
- `updated_at`: Last update timestamp
- `closed_at`: Close timestamp (if closed)
- `assignees`: List of assignees
- `labels`: List of labels
- `time_estimate`: Extracted time estimate
- `status_history`: Project board status history
- `url`: Issue URL

### GitHubRepository Class

Handles GitHub API interactions.

#### Methods
- `get_issues(state: str = "all")`: Pull all issues from repository
- `get_issue_with_project_history(issue_number: int, project_id: Optional[str])`: Get specific issue with project history
- `get_project_status_history(issue_number: int, project_id: str)`: Get project board status history for an issue

## Time Estimate Extraction

The library automatically extracts time estimates from issue descriptions using common patterns:

- "time estimate: 2 hours"
- "estimated time: 1 day"
- "effort: 3 days"
- "story points: 5"
- "points: 8"

## Authentication

The library automatically detects GitHub tokens from multiple sources:

1. **Environment Variables** - `GITHUB_TOKEN`, `GITHUB_PAT`, `GITHUB_ACCESS_TOKEN`, `GH_TOKEN`
2. **Git Configuration** - `git config github.token`
3. **GitHub CLI** - `gh auth token`
4. **Git Credential Store** - `git credential fill`
5. **Explicit Token** - Passed directly to constructor

## Project Board Integration

To use project board features:

1. Create a GitHub Personal Access Token with `read:org` and `read:project` permissions
2. Get your project board ID from the project URL
3. Pass both to the Kanlytics constructor

## Example

See `example.py` for a complete usage example.

## Requirements

- Python 3.7+
- requests>=2.31.0

## License

See LICENSE file for details.