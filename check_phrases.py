import sqlite3
conn = sqlite3.connect('dataset.db')
cur = conn.cursor()
cur.execute("SELECT label FROM samples WHERE landmarks = '[]'")
print(cur.fetchall())
conn.close()
