#!/usr/bin/env python3
"""
Example usage of the Kanlytics library for GitHub repository analysis.
"""

from kanlytics import Kanlytics

def main():
    # Example 1: Basic usage with public repository (issues loaded automatically)
    print("=== Basic Repository Analysis ===")
    kanlytics = Kanlytics("https://github.com/Mindtrace/mindtrace")
    
    # Check if GitHub token was auto-detected
    if kanlytics.has_github_token():
        print("✓ GitHub token auto-detected! (from config file, git config, environment, or GitHub CLI)")
    else:
        print("ℹ No GitHub token detected - using public API only")
    
    # Issues are already loaded! Just analyze them
    analysis = kanlytics.analyze_issues()
    
    print(f"Total issues: {analysis['total_issues']}")
    print(f"Open issues: {analysis['open_issues']}")
    print(f"Closed issues: {analysis['closed_issues']}")
    print(f"Issues with time estimates: {analysis['issues_with_time_estimates']}")
    print(f"Issues with assignees: {analysis['issues_with_assignees']}")
    
    print("\nAssignee distribution:")
    for assignee, count in analysis['assignee_distribution'].items():
        print(f"  {assignee}: {count}")
    
    print("\nTime estimates found:")
    for estimate in analysis['time_estimates'][:5]:  # Show first 5
        print(f"  {estimate}")
    
    # Example 2: Direct access to issues (new simplified API)
    print("\n=== Direct Issue Access ===")
    print(f"All issues: {len(kanlytics.issues)}")
    print(f"Open issues: {len(kanlytics.get_open_issues())}")
    print(f"Closed issues: {len(kanlytics.get_closed_issues())}")
    print(f"Issues with time estimates: {len(kanlytics.get_issues_with_time_estimates())}")
    
    # Get issues by assignee
    if kanlytics.issues:
        first_assignee = None
        for issue in kanlytics.issues:
            if issue.assignees:
                first_assignee = issue.assignees[0]['login']
                break
        
        if first_assignee:
            assignee_issues = kanlytics.get_issues_by_assignee(first_assignee)
            print(f"Issues assigned to {first_assignee}: {len(assignee_issues)}")
    
    # Example 3: Project Board Usage (fast mode by default)
    print("\n=== Project Board Usage ===")
    print("For project boards, use the project board URL:")
    print("kanlytics_board = Kanlytics('https://github.com/orgs/org/projects/27')  # Fast mode")
    print("kanlytics_board = Kanlytics('https://github.com/orgs/org/projects/27', load_history=True)  # Slow mode")
    print("analysis = kanlytics_board.analyze_issues()  # Issues already loaded!")
    
    # Example 4: Fast vs Slow mode comparison
    print("\n=== Fast vs Slow Mode Comparison ===")
    print("Fast mode (default): load_history=False - processes issues quickly (~1-2 seconds)")
    print("Slow mode: load_history=True - loads project board status history (~1-2 minutes)")
    print("Use slow mode only when you need detailed status history data")
    
    # Example 3: Get specific issue with project history
    print("\n=== Individual Issue Analysis ===")
    
    # Get a specific issue (example with issue #207)
    try:
        issue = kanlytics.repository.get_issue_with_project_history(207)
        if issue:
            print(f"Issue #{issue.number}: {issue.title}")
            print(f"State: {issue.state}")
            print(f"Time estimate: {issue.time_estimate}")
            print(f"Assignees: {[a['login'] for a in issue.assignees]}")
            print(f"Labels: {[l['name'] for l in issue.labels]}")
            print(f"URL: {issue.url}")
    except Exception as e:
        print(f"Error fetching issue: {e}")
    
    # Example 4: Show token detection sources
    print("\n=== Token Detection Information ===")
    print("The library automatically detects GitHub tokens from:")
    print("  1. Config file: kanlytics/config.ini (github_pat)")
    print("  2. Environment variables: GITHUB_TOKEN, GITHUB_PAT, GITHUB_ACCESS_TOKEN, GH_TOKEN")
    print("  3. Git configuration: git config github.token")
    print("  4. GitHub CLI: gh auth token")
    print("  5. Git credential store: git credential fill")
    print("  6. Explicitly provided token parameter")
    
    # Example 5: Show config file usage
    print("\n=== Config File Usage ===")
    print("You can create a config.ini file in the kanlytics/core directory:")
    print("[KANLYTICS]")
    print("github_pat = your_github_token_here")
    print("project_id = your_project_id_here")
    print("\nThe library will automatically load these values if no explicit parameters are provided.")

if __name__ == "__main__":
    main()
