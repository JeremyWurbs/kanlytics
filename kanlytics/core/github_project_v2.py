from __future__ import annotations

import os
import subprocess
import threading
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse
from uuid import uuid4

import requests

from mindtrace.core.utils import load_ini_as_dict


GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"


@dataclass(frozen=True)
class ProjectRef:
    scope: str  # "orgs" | "users"
    owner: str
    number: int


def _is_valid_token(token: str) -> bool:
    if not token or len(token) < 10:
        return False
    if len(token) == 40 and token.isalnum():
        return True
    if token.startswith(("ghp_", "gho_", "ghu_", "ghs_", "ghr_")):
        return True
    return False


def detect_github_token() -> Optional[str]:
    # 1) Config file
    try:
        from pathlib import Path

        config_path = Path(__file__).parent / "config.ini"
        config_dict = load_ini_as_dict(config_path)
        kanlytics_config = config_dict.get("KANLYTICS", {})
        token = kanlytics_config.get("github_pat", "") or kanlytics_config.get("GITHUB_PAT", "")
        if token and _is_valid_token(token):
            return token
    except Exception:
        pass

    # 2) Env vars
    for env_var in ("GITHUB_TOKEN", "GITHUB_PAT", "GITHUB_ACCESS_TOKEN", "GH_TOKEN"):
        token = os.getenv(env_var)
        if token and _is_valid_token(token):
            return token

    # 3) git config
    try:
        result = subprocess.run(
            ["git", "config", "--get", "github.token"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            token = result.stdout.strip()
            if token and _is_valid_token(token):
                return token
    except Exception:
        pass

    # 4) GitHub CLI
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            token = result.stdout.strip()
            if token and _is_valid_token(token):
                return token
    except Exception:
        pass

    return None


def parse_project_url(project_url: str) -> ProjectRef:
    """
    Accepts:
      - https://github.com/orgs/{org}/projects/{number}
      - https://github.com/users/{user}/projects/{number}
    """
    parsed = urlparse(project_url)
    if parsed.netloc != "github.com":
        raise ValueError("Project URL must be on github.com")

    parts = parsed.path.strip("/").split("/")
    if len(parts) < 4 or parts[2] != "projects" or parts[0] not in ("orgs", "users"):
        raise ValueError("Invalid GitHub Project URL format (expected /orgs/.../projects/... or /users/.../projects/...)")

    owner = parts[1]
    number_str = parts[3]
    try:
        number = int(number_str)
    except ValueError as e:
        raise ValueError("Project number must be an integer") from e

    return ProjectRef(scope=parts[0], owner=owner, number=number)


def parse_repo_ref(repo: str) -> Tuple[str, str]:
    """
    Accepts:
      - "owner/repo"
      - "https://github.com/owner/repo"
    Returns:
      (owner, repo)
    """
    s = (repo or "").strip()
    if not s:
        raise ValueError("Repo is required")
    if s.startswith("http://") or s.startswith("https://"):
        parsed = urlparse(s)
        if parsed.netloc != "github.com":
            raise ValueError("Repo URL must be on github.com")
        parts = parsed.path.strip("/").split("/")
        if len(parts) < 2:
            raise ValueError("Invalid GitHub repo URL format")
        return parts[0], parts[1]
    if "/" not in s:
        raise ValueError("Repo must be in 'owner/repo' format (or a GitHub repo URL)")
    owner, name = s.split("/", 1)
    owner = owner.strip()
    name = name.strip()
    if not owner or not name:
        raise ValueError("Repo must be in 'owner/repo' format")
    return owner, name


class GitHubProjectV2:
    def __init__(self, project_url: str, github_token: Optional[str] = None) -> None:
        self.project_url = project_url
        self.ref = parse_project_url(project_url)
        self.github_token = github_token or detect_github_token()
        if not self.github_token:
            raise ValueError("GitHub token required for ProjectV2 access (set in config.ini or env var like GITHUB_TOKEN)")

        self._headers = {
            "Authorization": f"token {self.github_token}",
            "Content-Type": "application/json",
            "Accept": "application/vnd.github+json",
            "User-Agent": "kanlytics/1.0",
        }

        # Reuse HTTP connections (massively reduces export time).
        self._session = requests.Session()
        self._tls = threading.local()

        self.project_id = self._resolve_project_id()
        self._label_cache_by_repo: Dict[Tuple[str, str], set[str]] = {}
        self._label_lock = threading.RLock()
        # _project_title is set in _resolve_project_id() when fetching the project

    def _rest_session(self) -> requests.Session:
        """
        Return a per-thread requests.Session so REST calls can be safely parallelized.
        """
        s = getattr(self._tls, "session", None)
        if s is None:
            s = requests.Session()
            setattr(self._tls, "session", s)
        return s

    def _graphql(self, query: str, variables: Dict[str, Any]) -> Dict[str, Any]:
        # Use a thread-local session to avoid cross-thread session sharing.
        res = self._rest_session().post(GITHUB_GRAPHQL_URL, headers=self._headers, json={"query": query, "variables": variables})
        res.raise_for_status()
        data = res.json()
        if "errors" in data:
            raise ValueError(f"GitHub GraphQL error: {data['errors']}")
        return data.get("data", {})

    def set_fields_bulk(self, *, item_id: str, updates: List[Tuple[str, Dict[str, Any]]]) -> None:
        """
        Set multiple ProjectV2 item fields in a single GraphQL request.

        This is significantly faster than calling set_text_field / set_date_field / set_single_select_field
        repeatedly (which would require one HTTP request per field).

        Args:
          item_id: ProjectV2 item id
          updates: list of (field_id, value_dict) where value_dict matches the GraphQL input, e.g.
            - {"text": "abc"}
            - {"date": "2026-01-01"}
            - {"singleSelectOptionId": "<option_id>"}
        """
        if not updates:
            return

        # Build a mutation with N aliased calls:
        # mutation($i0: UpdateProjectV2ItemFieldValueInput!, ...) {
        #   u0: updateProjectV2ItemFieldValue(input: $i0) { projectV2Item { id } }
        #   ...
        # }
        var_defs: List[str] = []
        body_lines: List[str] = []
        variables: Dict[str, Any] = {}
        for idx, (field_id, value) in enumerate(updates):
            var = f"i{idx}"
            alias = f"u{idx}"
            var_defs.append(f"${var}: UpdateProjectV2ItemFieldValueInput!")
            body_lines.append(f'  {alias}: updateProjectV2ItemFieldValue(input: ${var}) {{ projectV2Item {{ id }} }}')
            variables[var] = {
                "projectId": self.project_id,
                "itemId": item_id,
                "fieldId": field_id,
                "value": value,
            }

        mutation = "mutation(" + ", ".join(var_defs) + ") {\n" + "\n".join(body_lines) + "\n}"
        self._graphql(mutation, variables)

    def _resolve_project_id(self) -> str:
        if self.ref.scope == "orgs":
            query = """
            query($org: String!, $number: Int!) {
              organization(login: $org) {
                projectV2(number: $number) { id title }
              }
            }
            """
            data = self._graphql(query, {"org": self.ref.owner, "number": self.ref.number})
            proj = (data.get("organization") or {}).get("projectV2")
        else:
            query = """
            query($user: String!, $number: Int!) {
              user(login: $user) {
                projectV2(number: $number) { id title }
              }
            }
            """
            data = self._graphql(query, {"user": self.ref.owner, "number": self.ref.number})
            proj = (data.get("user") or {}).get("projectV2")

        if not proj or not proj.get("id"):
            raise ValueError("Could not resolve ProjectV2 id from URL")
        # Store title for later retrieval
        self._project_title = proj.get("title") or ""
        return proj["id"]
    
    def get_project_title(self) -> str:
        """Get the title/name of the GitHub ProjectV2."""
        if not hasattr(self, "_project_title"):
            # If title wasn't fetched during initialization, fetch it now
            if self.ref.scope == "orgs":
                query = """
                query($org: String!, $number: Int!) {
                  organization(login: $org) {
                    projectV2(number: $number) { title }
                  }
                }
                """
                data = self._graphql(query, {"org": self.ref.owner, "number": self.ref.number})
                proj = (data.get("organization") or {}).get("projectV2")
            else:
                query = """
                query($user: String!, $number: Int!) {
                  user(login: $user) {
                    projectV2(number: $number) { title }
                  }
                }
                """
                data = self._graphql(query, {"user": self.ref.owner, "number": self.ref.number})
                proj = (data.get("user") or {}).get("projectV2")
            self._project_title = (proj or {}).get("title") or ""
        return self._project_title

    def list_fields(self) -> List[Dict[str, Any]]:
        query = """
        query($projectId: ID!) {
          node(id: $projectId) {
            ... on ProjectV2 {
              fields(first: 100) {
                nodes {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                    dataType
                  }
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    dataType
                    options {
                      id
                      name
                      color
                    }
                  }
                }
              }
            }
          }
        }
        """
        data = self._graphql(query, {"projectId": self.project_id})
        nodes = (((data.get("node") or {}).get("fields") or {}).get("nodes") or [])
        return [n for n in nodes if isinstance(n, dict) and n.get("id") and n.get("name")]

    def ensure_text_field(self, name: str, read_only: bool = False) -> Optional[str]:
        """
        Get the field ID for a text field, creating it if it doesn't exist.
        
        When read_only=True, only reads the field without creating it.
        Returns None if the field doesn't exist and read_only=True.
        """
        for f in self.list_fields():
            if (f.get("name") or "").strip().lower() == name.strip().lower():
                return f["id"]

        if read_only:
            # For read-only operations (import), don't create the field
            return None

        mutation = """
        mutation($input: CreateProjectV2FieldInput!) {
          createProjectV2Field(input: $input) {
            projectV2Field {
              ... on ProjectV2FieldCommon { id name dataType }
            }
          }
        }
        """
        data = self._graphql(
            mutation,
            {
                "input": {
                    "projectId": self.project_id,
                    "name": name,
                    "dataType": "TEXT",
                }
            },
        )
        field = (((data.get("createProjectV2Field") or {}).get("projectV2Field")) or {})
        field_id = field.get("id")
        if not field_id:
            raise ValueError("Failed to create ProjectV2 text field")
        return field_id

    def ensure_date_field(self, name: str) -> str:
        for f in self.list_fields():
            if (f.get("name") or "").strip().lower() == name.strip().lower():
                return f["id"]

        mutation = """
        mutation($input: CreateProjectV2FieldInput!) {
          createProjectV2Field(input: $input) {
            projectV2Field {
              ... on ProjectV2FieldCommon { id name dataType }
            }
          }
        }
        """
        data = self._graphql(
            mutation,
            {
                "input": {
                    "projectId": self.project_id,
                    "name": name,
                    "dataType": "DATE",
                }
            },
        )
        field = (((data.get("createProjectV2Field") or {}).get("projectV2Field")) or {})
        field_id = field.get("id")
        if not field_id:
            raise ValueError("Failed to create ProjectV2 date field")
        return field_id

    def ensure_status_columns(self, *, options: List[str], default: str = "Backlog", read_only: bool = False) -> Tuple[Optional[str], Dict[str, str]]:
        """
        Ensure the ProjectV2 single-select field "Status" has exactly the provided options.
        Also ensures every project item has a valid status, defaulting missing/unknown to `default`.
        
        When read_only=True, only reads the Status field without modifying the project board.
        This should be used for import/connect operations to avoid changing the actual project.
        In read_only mode, returns (None, {}) if the Status field doesn't exist.

        Returns:
          (status_field_id, option_id_by_name) - status_field_id may be None in read_only mode
        """
        status_field = None
        for f in self.list_fields():
            if (f.get("name") or "").strip().lower() == "status":
                status_field = f
                break

        # If Status doesn't exist and we're in read-only mode, return None to indicate field doesn't exist
        if status_field is None:
            if read_only:
                # In read-only mode, don't create the field - just return None
                return None, {}
            # If Status doesn't exist, create it as SINGLE_SELECT (only in write mode).
            mutation = """
            mutation($input: CreateProjectV2FieldInput!) {
              createProjectV2Field(input: $input) {
                projectV2Field {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    dataType
                    options { id name color }
                  }
                }
              }
            }
            """
            # GitHub's API currently validates `description` as non-null for option inputs.
            # Provide an explicit empty string so the value is never null.
            single_select_options = [
                {"name": options[0], "description": "", "color": "BLUE"},
                {"name": options[1], "description": "", "color": "GRAY"},
                {"name": options[2], "description": "", "color": "YELLOW"},
                {"name": options[3], "description": "", "color": "PURPLE"},
                {"name": options[4], "description": "", "color": "GREEN"},
            ]
            data = self._graphql(
                mutation,
                {
                    "input": {
                        "projectId": self.project_id,
                        "name": "Status",
                        "dataType": "SINGLE_SELECT",
                        "singleSelectOptions": single_select_options,
                    }
                },
            )
            status_field = (((data.get("createProjectV2Field") or {}).get("projectV2Field")) or {})

        if (status_field.get("dataType") or "").upper() != "SINGLE_SELECT":
            raise ValueError('Project field "Status" exists but is not a SINGLE_SELECT field.')

        status_field_id = status_field["id"]

        # Normalize options to exactly what we want (order matters for display).
        # Skip this if read_only=True to avoid modifying the project board.
        existing_names = [(o.get("name") or "").strip() for o in (status_field.get("options") or []) if isinstance(o, dict)]
        want = [o.strip() for o in options]
        if not read_only and existing_names != want:
            mutation = """
            mutation($input: UpdateProjectV2FieldInput!) {
              updateProjectV2Field(input: $input) {
                projectV2Field {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    dataType
                    options { id name color }
                  }
                }
              }
            }
            """
            # GitHub's API currently validates `description` as non-null for option inputs.
            single_select_options = [
                {"name": want[0], "description": "", "color": "BLUE"},
                {"name": want[1], "description": "", "color": "GRAY"},
                {"name": want[2], "description": "", "color": "YELLOW"},
                {"name": want[3], "description": "", "color": "PURPLE"},
                {"name": want[4], "description": "", "color": "GREEN"},
            ]
            data = self._graphql(
                mutation,
                {
                    "input": {
                        "fieldId": status_field_id,
                        "singleSelectOptions": single_select_options,
                    }
                },
            )
            status_field = (((data.get("updateProjectV2Field") or {}).get("projectV2Field")) or {})

        option_id_by_name: Dict[str, str] = {}
        for opt in (status_field.get("options") or []):
            if not isinstance(opt, dict):
                continue
            nm = (opt.get("name") or "").strip()
            oid = opt.get("id")
            if nm and oid:
                option_id_by_name[nm] = oid

        if not read_only:
            if default not in option_id_by_name:
                raise ValueError(f'Default status "{default}" not present in Status options.')

            # Ensure all items have a valid status option set; set missing/unknown to default.
            # Skip this if read_only=True to avoid modifying the project board.
            for item in self.iter_items():
                item_id = item.get("id")
                if not item_id:
                    continue
                current_name = self._get_single_select_value(item, "Status")
                if not current_name or current_name not in option_id_by_name:
                    self.set_single_select_field(item_id=item_id, field_id=status_field_id, option_id=option_id_by_name[default])

        return status_field_id, option_id_by_name

    def iter_items(self) -> Iterable[Dict[str, Any]]:
        query = """
        query($projectId: ID!, $first: Int!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  content {
                    __typename
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
                      repository { name owner { login } }
                      labels(first: 20) { nodes { name } }
                      assignees(first: 20) { nodes { login } }
                    }
                    ... on DraftIssue {
                      id
                      title
                      body
                      createdAt
                      updatedAt
                    }
                  }
                  fieldValues(first: 50) {
                    nodes {
                      ... on ProjectV2ItemFieldTextValue {
                        text
                        field { ... on ProjectV2FieldCommon { id name } }
                      }
                      ... on ProjectV2ItemFieldDateValue {
                        date
                        field { ... on ProjectV2FieldCommon { id name } }
                      }
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field { ... on ProjectV2FieldCommon { id name } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        """

        after: Optional[str] = None
        while True:
            data = self._graphql(query, {"projectId": self.project_id, "first": 100, "after": after})
            items = (((data.get("node") or {}).get("items") or {}))
            nodes = items.get("nodes") or []
            for n in nodes:
                if isinstance(n, dict):
                    yield n
            page_info = items.get("pageInfo") or {}
            if not page_info.get("hasNextPage"):
                break
            after = page_info.get("endCursor")

    @staticmethod
    def _get_text_field_value(item: Dict[str, Any], field_name: str) -> Optional[str]:
        fvs = ((item.get("fieldValues") or {}).get("nodes") or [])
        for fv in fvs:
            if not isinstance(fv, dict):
                continue
            field = fv.get("field") or {}
            if (field.get("name") or "").strip().lower() != field_name.strip().lower():
                continue
            if "text" in fv:
                val = (fv.get("text") or "").strip()
                return val or None
        return None

    @staticmethod
    def _get_single_select_value(item: Dict[str, Any], field_name: str) -> Optional[str]:
        fvs = ((item.get("fieldValues") or {}).get("nodes") or [])
        for fv in fvs:
            if not isinstance(fv, dict):
                continue
            field = fv.get("field") or {}
            if (field.get("name") or "").strip().lower() != field_name.strip().lower():
                continue
            if "name" in fv:
                val = (fv.get("name") or "").strip()
                return val or None
        return None

    @staticmethod
    def _get_date_field_value(item: Dict[str, Any], field_name: str) -> Optional[str]:
        fvs = ((item.get("fieldValues") or {}).get("nodes") or [])
        for fv in fvs:
            if not isinstance(fv, dict):
                continue
            field = fv.get("field") or {}
            if (field.get("name") or "").strip().lower() != field_name.strip().lower():
                continue
            if "date" in fv:
                val = (fv.get("date") or "").strip()
                return val or None
        return None

    def set_text_field(self, *, item_id: str, field_id: str, text: str) -> None:
        mutation = """
        mutation($input: UpdateProjectV2ItemFieldValueInput!) {
          updateProjectV2ItemFieldValue(input: $input) {
            projectV2Item { id }
          }
        }
        """
        self._graphql(
            mutation,
            {
                "input": {
                    "projectId": self.project_id,
                    "itemId": item_id,
                    "fieldId": field_id,
                    "value": {"text": text},
                }
            },
        )

    def set_single_select_field(self, *, item_id: str, field_id: str, option_id: str) -> None:
        mutation = """
        mutation($input: UpdateProjectV2ItemFieldValueInput!) {
          updateProjectV2ItemFieldValue(input: $input) {
            projectV2Item { id }
          }
        }
        """
        self._graphql(
            mutation,
            {
                "input": {
                    "projectId": self.project_id,
                    "itemId": item_id,
                    "fieldId": field_id,
                    "value": {"singleSelectOptionId": option_id},
                }
            },
        )

    def set_date_field(self, *, item_id: str, field_id: str, date: str) -> None:
        mutation = """
        mutation($input: UpdateProjectV2ItemFieldValueInput!) {
          updateProjectV2ItemFieldValue(input: $input) {
            projectV2Item { id }
          }
        }
        """
        self._graphql(
            mutation,
            {
                "input": {
                    "projectId": self.project_id,
                    "itemId": item_id,
                    "fieldId": field_id,
                    "value": {"date": date},
                }
            },
        )

    def add_draft_issue(self, *, title: str, body: str) -> str:
        mutation = """
        mutation($input: AddProjectV2DraftIssueInput!) {
          addProjectV2DraftIssue(input: $input) {
            projectItem { id }
          }
        }
        """
        data = self._graphql(
            mutation,
            {
                "input": {
                    "projectId": self.project_id,
                    "title": title,
                    "body": body,
                }
            },
        )
        item_id = (((data.get("addProjectV2DraftIssue") or {}).get("projectItem") or {}).get("id"))
        if not item_id:
            raise ValueError("Failed to create draft issue item")
        return item_id

    def update_draft_issue(self, *, draft_issue_id: str, title: str, body: str) -> None:
        mutation = """
        mutation($input: UpdateProjectV2DraftIssueInput!) {
          updateProjectV2DraftIssue(input: $input) {
            draftIssue { id }
          }
        }
        """
        self._graphql(
            mutation,
            {
                "input": {
                    "draftIssueId": draft_issue_id,
                    "title": title,
                    "body": body,
                }
            },
        )

    def add_issue_item(self, *, issue_node_id: str) -> str:
        mutation = """
        mutation($input: AddProjectV2ItemByIdInput!) {
          addProjectV2ItemById(input: $input) {
            item { id }
          }
        }
        """
        data = self._graphql(
            mutation,
            {
                "input": {
                    "projectId": self.project_id,
                    "contentId": issue_node_id,
                }
            },
        )
        item_id = (((data.get("addProjectV2ItemById") or {}).get("item") or {}).get("id"))
        if not item_id:
            raise ValueError("Failed to add issue to project board")
        return item_id

    def resolve_issue_node_id(self, *, owner: str, repo: str, number: int) -> str:
        query = """
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) { id }
          }
        }
        """
        data = self._graphql(query, {"owner": owner, "repo": repo, "number": number})
        issue = (((data.get("repository") or {}).get("issue")) or {})
        issue_id = issue.get("id")
        if not issue_id:
            raise ValueError("Could not resolve issue node id")
        return issue_id

    @staticmethod
    def parse_issue_url(issue_url: str) -> Tuple[str, str, int]:
        parsed = urlparse(issue_url)
        if parsed.netloc != "github.com":
            raise ValueError("Issue URL must be on github.com")
        parts = parsed.path.strip("/").split("/")
        # /{owner}/{repo}/issues/{number}
        if len(parts) < 4 or parts[2] != "issues":
            raise ValueError("Invalid issue URL format")
        return parts[0], parts[1], int(parts[3])

    def update_issue_rest(self, *, issue_url: str, title: str, body: str, labels: List[str], assignees: List[str]) -> None:
        owner, repo, number = self.parse_issue_url(issue_url)
        api = f"https://api.github.com/repos/{owner}/{repo}/issues/{number}"
        payload: Dict[str, Any] = {"title": title, "body": body}
        # Labels/assignees can fail if missing permissions or labels don't exist; still best-effort.
        if labels is not None:
            payload["labels"] = labels
        if assignees is not None:
            payload["assignees"] = assignees
        res = self._rest_session().patch(api, headers=self._headers, json=payload)
        res.raise_for_status()

    def create_issue_rest(self, *, repo: str, title: str, body: str, labels: List[str], assignees: List[str]) -> str:
        """
        Create an Issue in the provided repo and return the HTML URL.
        """
        owner, name = parse_repo_ref(repo)
        api = f"https://api.github.com/repos/{owner}/{name}/issues"
        payload: Dict[str, Any] = {"title": title, "body": body}
        if labels is not None:
            payload["labels"] = labels
        if assignees is not None:
            payload["assignees"] = assignees
        res = self._rest_session().post(api, headers=self._headers, json=payload)
        res.raise_for_status()
        data = res.json()
        url = data.get("html_url")
        if not url:
            raise ValueError("Issue creation succeeded but no html_url returned")
        return url

    def _list_labels_rest(self, *, owner: str, repo: str) -> set[str]:
        """
        Return existing label names for a repo (cached).
        """
        key = (owner, repo)
        with self._label_lock:
            if key in self._label_cache_by_repo:
                return set(self._label_cache_by_repo[key])

        labels: set[str] = set()
        page = 1
        while True:
            api = f"https://api.github.com/repos/{owner}/{repo}/labels"
            res = self._rest_session().get(api, headers=self._headers, params={"per_page": 100, "page": page})
            res.raise_for_status()
            data = res.json()
            if not isinstance(data, list) or not data:
                break
            for item in data:
                if isinstance(item, dict):
                    name = (item.get("name") or "").strip()
                    if name:
                        labels.add(name.lower())
            page += 1

        with self._label_lock:
            self._label_cache_by_repo[key] = set(labels)
        return set(labels)

    @staticmethod
    def _label_color_hex(name: str) -> str:
        """
        Deterministic label color from name.
        """
        import hashlib

        h = hashlib.sha1(name.encode("utf-8")).hexdigest()
        return h[:6]

    def _create_label_rest(self, *, owner: str, repo: str, name: str) -> None:
        api = f"https://api.github.com/repos/{owner}/{repo}/labels"
        payload: Dict[str, Any] = {
            "name": name,
            "color": self._label_color_hex(name),
            "description": "",
        }
        res = self._rest_session().post(api, headers=self._headers, json=payload)
        # If it already exists, GitHub returns 422. Treat as success.
        if res.status_code == 422:
            return
        res.raise_for_status()

    def ensure_labels_exist(self, *, repo: str, labels: List[str]) -> List[str]:
        """
        Best-effort: create missing labels in the target repo and return the list of labels
        that should be safe to apply to issues.
        """
        if not labels:
            return []
        owner, name = parse_repo_ref(repo)
        existing = self._list_labels_rest(owner=owner, repo=name)

        # Create any missing labels (case-insensitive)
        for lbl in labels:
            nm = (lbl or "").strip()
            if not nm:
                continue
            if nm.lower() in existing:
                continue
            try:
                self._create_label_rest(owner=owner, repo=name, name=nm)
                existing.add(nm.lower())
            except Exception:
                # If label creation fails (permissions), we'll just avoid sending it.
                continue

        # Only return labels that now exist (case-insensitive match).
        out: List[str] = []
        seen: set[str] = set()
        for lbl in labels:
            nm = (lbl or "").strip()
            if not nm:
                continue
            key = nm.lower()
            if key in existing and key not in seen:
                out.append(nm)
                seen.add(key)
        # refresh cache
        with self._label_lock:
            self._label_cache_by_repo[(owner, name)] = set(existing)
        return out


def new_uuid() -> str:
    return str(uuid4())

