#!/usr/bin/env python3
"""
Simple test script for Kanlytics functionality.
"""

import sys
import os

# Add the current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kanlytics import Kanlytics, GitHubIssue

def test_github_issue():
    """Test GitHubIssue class functionality."""
    print("Testing GitHubIssue class...")
    
    # Test issue with time estimate
    issue_with_estimate = GitHubIssue(
        number=1,
        title="Test Issue",
        body="This is a test issue with time estimate: 2 hours",
        state="open",
        created_at="2023-01-01T00:00:00Z",
        updated_at="2023-01-01T00:00:00Z",
        closed_at=None,
        assignees=[{"login": "testuser"}],
        labels=[{"name": "bug"}],
        url="https://github.com/test/repo/issues/1"
    )
    
    assert issue_with_estimate.time_estimate == "2 hours"
    print("✓ Time estimate extraction works")
    
    # Test issue without time estimate
    issue_without_estimate = GitHubIssue(
        number=2,
        title="Test Issue 2",
        body="This is a test issue without time estimate",
        state="open",
        created_at="2023-01-01T00:00:00Z",
        updated_at="2023-01-01T00:00:00Z",
        closed_at=None,
        assignees=[],
        labels=[],
        url="https://github.com/test/repo/issues/2"
    )
    
    assert issue_without_estimate.time_estimate is None
    print("✓ No time estimate handling works")

def test_kanlytics_basic():
    """Test basic Kanlytics functionality."""
    print("\nTesting Kanlytics basic functionality...")
    
    try:
        # Test with a public repository
        kanlytics = Kanlytics("https://github.com/Mindtrace/mindtrace")
        print("✓ Kanlytics initialization works")
        
        # Test repository parsing
        assert kanlytics.repository.owner == "Mindtrace"
        assert kanlytics.repository.repo == "mindtrace"
        print("✓ Repository URL parsing works")
        
    except Exception as e:
        print(f"✗ Basic test failed: {e}")

def main():
    """Run all tests."""
    print("Running Kanlytics tests...\n")
    
    test_github_issue()
    test_kanlytics_basic()
    
    print("\nAll tests completed!")

if __name__ == "__main__":
    main()
