"""Test script for Gantt chart functionality."""
from kanlytics.gantt import Gantt
from datetime import date

# Test loading CSV
csv_path = "/Users/jeremywurbs/Downloads/AI_Deployment_Master_Task_Checklist_Mindtrace_Adient(Project Task List).csv"

print("Loading Gantt chart from CSV...")
gantt = Gantt.from_csv(csv_path)

# Print some statistics
print(f"\nProject Statistics:")
print(f"Total tasks: {len(gantt.tasks)}")

# Show tasks by phase
from collections import Counter
phases = Counter(task.phase for task in gantt.tasks)
print(f"\nTasks by Phase:")
for phase, count in sorted(phases.items()):
    print(f"  {phase}: {count} tasks")

# Schedule the project
print(f"\nScheduling project...")
start_date = date(2024, 1, 1)
gantt.schedule(start_date, duration_mode="wall")

# Export layout
print(f"\nExporting layout...")
layout = gantt.export_layout()

print(f"\nLayout Export:")
print(f"  Project start: {layout['meta']['project_start']}")
print(f"  Duration mode: {layout['meta']['duration_mode']}")
print(f"  Working days: {layout['meta']['working_days']}")
print(f"  Total tasks: {len(layout['tasks'])}")
print(f"  Total dependency edges: {len(layout['edges'])}")

# Show sample task data
print(f"\nSample task data (first 3 tasks):")
for task in layout['tasks'][:3]:
    print(f"  Task {task['id']} ({task['phase']}):")
    print(f"    Name: {task['name']}")
    print(f"    Schedule: {task['schedule']['start']} to {task['schedule']['end']}")
    print(f"    Row: {task['schedule']['row']}, X: {task['schedule']['x']}, Width: {task['schedule']['w']}")
    if task['dependencies']:
        print(f"    Dependencies: {', '.join(task['dependencies'])}")

# Show sample edges
print(f"\nSample dependency edges (first 5):")
for edge in layout['edges'][:5]:
    print(f"  {edge['from']} -> {edge['to']}")

# Calculate project end date
if layout['tasks']:
    end_dates = [task['schedule']['end'] for task in layout['tasks']]
    project_end = max(end_dates)
    print(f"\nProject end date: {project_end}")

print(f"\nDone! Layout data is ready for frontend rendering.")
