import re
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field


@dataclass
class GitHubIssue:
    """Represents a GitHub issue with all associated information."""
    number: int
    title: str
    body: str
    state: str
    created_at: str
    updated_at: str
    closed_at: Optional[str]
    assignees: List[Dict[str, Any]]
    labels: List[Dict[str, Any]]
    time_estimate: Optional[str] = None
    status_history: List[Dict[str, Any]] = field(default_factory=list)
    url: str = ""
    
    def __post_init__(self):
        """Extract time estimate from issue body after initialization."""
        self.time_estimate = self._extract_time_estimate()
    
    def _extract_time_estimate(self) -> Optional[str]:
        """Extract time estimate from issue body using common patterns."""
        if not self.body:
            return None
            
        # Common time estimate patterns
        patterns = [
            r'time estimate[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)',
            r'estimated time[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)',
            r'estimate[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)',
            r'effort[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)',
            r'story points[:\s]*([0-9]+(?:\.[0-9]+)?)',
            r'points[:\s]*([0-9]+(?:\.[0-9]+)?)',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, self.body, re.IGNORECASE)
            if match:
                value = match.group(1)
                unit = match.group(2) if len(match.groups()) > 1 else "points"
                return f"{value} {unit}"
        
        return None
